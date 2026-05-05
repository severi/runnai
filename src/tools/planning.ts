import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import * as fs from "fs/promises";
import * as path from "path";
import { evaluate } from "mathjs";
import { getDataDir } from "../utils/paths.js";
import { sanitizeFilename, toDateString, toolResult, toolError } from "../utils/format.js";
import { withDiffNote } from "../utils/data-git.js";
import {
  getPlanDir,
  getPlanFile,
  getDraftDir,
  getDraftPlanFile,
  getDraftReasoningFile,
  isDraftActive,
  listPlanSlugs,
  nextDraftVersion,
} from "../utils/plan-paths.js";
import { renderDiff } from "../utils/plan-diff.js";
import { writeFrontmatter, parseFrontmatter } from "../utils/plan-frontmatter.js";
import { appendChangelogEntry } from "../utils/plan-changelog.js";
import { appendToSection } from "../utils/plan-reasoning.js";
import { beginRevision, finalizeRevision, discardRevision } from "../utils/plan-versions.js";

export const planManagerTool = tool(
  "manage_plan",
  "Manage training plans: create, read, update, delete, or list plans.",
  {
    action: z.enum([
      "create", "read", "update", "delete", "list",
      "revise", "finalize", "discard", "rename",
      "diff", "show",
    ]).describe("Action to perform"),
    planName: z.string().optional().describe("Name of the plan"),
    content: z.string().optional().describe("Full plan content in markdown. For 'update', this REPLACES the entire file — pass the complete plan, not a partial patch."),
    newSlug: z.string().optional().describe("New slug for 'rename'. Only lowercase letters, numbers, hyphens."),
    allowEmpty: z.boolean().optional().describe("If true, finalize proceeds even with empty required reasoning sections. Default false."),
    changelogTitle: z.string().optional().describe("Custom changelog title for finalize."),
    changelogBody: z.string().optional().describe("Custom changelog body for finalize."),
    mode: z.enum(["summary", "unified"]).optional().describe("Diff mode: summary (markdown table + per-week) or unified (git-style)."),
    inline: z.boolean().optional().describe("If true, return diff in chat scrollback instead of writing to file."),
    target: z.enum(["current", "draft"]).optional().describe("show: which version to render."),
  },
  async ({ action, planName, content, newSlug, allowEmpty, changelogTitle, changelogBody, mode, inline, target }) => {
    try {
      switch (action) {
        case "list": {
          const slugs = await listPlanSlugs();
          if (slugs.length === 0) return toolResult("No training plans found.");
          let result = "**Available Training Plans:**\n\n";
          for (const slug of slugs) {
            const planFile = getPlanFile(slug);
            let stat;
            try {
              stat = await fs.stat(planFile);
            } catch {
              continue;
            }
            const fileContent = await fs.readFile(planFile, "utf-8");
            const { frontmatter, body } = parseFrontmatter(fileContent);
            const title = frontmatter?.title ?? body.split("\n")[0].replace(/^#\s*/, "");
            const draftSuffix = (await isDraftActive(slug)) ? " ⏳ revision in progress" : "";
            result += `- **${slug}**: ${title}${draftSuffix}\n  Last modified: ${stat.mtime.toLocaleDateString()}\n`;
          }
          return toolResult(result);
        }

        case "create": {
          if (!planName || !content) return toolResult("Error: planName and content are required.", true);
          const slug = sanitizeFilename(planName);
          const planDir = getPlanDir(slug);
          if (await fs.stat(planDir).then(() => true).catch(() => false)) {
            return toolResult(`Plan '${planName}' already exists. Use 'update' to modify.`, true);
          }
          await fs.mkdir(planDir, { recursive: true });
          await fs.mkdir(path.join(planDir, "references"), { recursive: true });
          await fs.mkdir(path.join(planDir, "research"), { recursive: true });
          await fs.mkdir(path.join(planDir, "versions"), { recursive: true });

          const withFm = writeFrontmatter({ title: planName, slug, created: toDateString() }, content);
          await fs.writeFile(getPlanFile(slug), withFm);
          await fs.mkdir(path.join(planDir, "versions", "v1"), { recursive: true });
          await fs.writeFile(path.join(planDir, "versions", "v1", "plan.md"), withFm);
          await fs.writeFile(path.join(planDir, "versions", "v1", "reasoning.md"), `# v1\n\n## Trigger\nPlan created.\n`);
          await fs.writeFile(path.join(planDir, "references", "INDEX.md"), "# References\n\n");
          await fs.writeFile(path.join(planDir, "research", "INDEX.md"), "# Research used in this plan\n\n");
          await appendChangelogEntry(slug, { date: toDateString(), title: "v1: created", body: `Initial plan: ${planName}.` });

          return toolResult(await withDiffNote(`Created training plan '${planName}'. Saved to: ${slug}/plan.md`));
        }

        case "read": {
          if (!planName) return toolResult("Error: planName is required.", true);
          const slug = sanitizeFilename(planName);
          let planContent: string;
          try {
            planContent = await fs.readFile(getPlanFile(slug), "utf-8");
          } catch {
            return toolResult(`Plan '${planName}' not found.`, true);
          }
          const note = (await isDraftActive(slug)) ? "\n\n_⏳ Revision in progress: see versions/vN-draft/plan.md for the current draft._" : "";
          return toolResult(`**Training Plan: ${planName}**\n\n${planContent}${note}`);
        }

        case "update": {
          if (!planName || !content) return toolResult("Error: planName and content are required.", true);
          const slug = sanitizeFilename(planName);
          const draft = await isDraftActive(slug);
          const draftVersion = await nextDraftVersion(slug);
          const targetPath = draft ? getDraftPlanFile(slug, draftVersion) : getPlanFile(slug);

          let existing: string;
          try {
            existing = await fs.readFile(targetPath, "utf-8");
          } catch {
            return toolResult(`Plan '${planName}' not found at ${targetPath}.`, true);
          }
          if (existing.length > 500 && content.length < existing.length * 0.5) {
            return toolResult(
              `Error: update content (${content.length} chars) is much shorter than existing (${existing.length} chars). 'update' replaces the entire file — pass the full plan, not a partial patch.`,
              true,
            );
          }
          await fs.writeFile(targetPath, content);

          if (draft) {
            await appendToSection(
              getDraftReasoningFile(slug, draftVersion),
              "Decisions and rationale",
              `- ${toDateString()}: edited draft plan.md.`,
            );
            return toolResult(await withDiffNote(`Updated draft '${planName}' (v${draftVersion}-draft).`));
          } else {
            await appendChangelogEntry(slug, {
              date: toDateString(),
              title: "plan updated",
              body: "Direct update via manage_plan.",
            });
            return toolResult(await withDiffNote(`Updated training plan '${planName}'.`));
          }
        }

        case "delete": {
          if (!planName) return toolResult("Error: planName is required.", true);
          const slug = sanitizeFilename(planName);
          const planDir = getPlanDir(slug);
          try {
            await fs.rm(planDir, { recursive: true });
            return toolResult(`Deleted training plan '${planName}'.`);
          } catch {
            return toolResult(`Plan '${planName}' not found.`, true);
          }
        }

        case "revise": {
          if (!planName) return toolResult("Error: planName is required.", true);
          const slug = sanitizeFilename(planName);
          try {
            const result = await beginRevision(slug);
            return toolResult(
              `entered revision mode → versions/v${result.draftVersion}-draft created. Edit via manage_plan(action: 'update'). Finalize with action: 'finalize' or discard with 'discard'.`,
            );
          } catch (e) {
            return toolError(e);
          }
        }

        case "finalize": {
          if (!planName) return toolResult("Error: planName is required.", true);
          const slug = sanitizeFilename(planName);
          try {
            const result = await finalizeRevision(slug, { allowEmpty, changelogTitle, changelogBody });
            const warningText = result.warnings.length > 0 ? `\n\nWarnings:\n${result.warnings.join("\n")}` : "";
            return toolResult(await withDiffNote(`finalized v${result.version} → live plan now reflects v${result.version}.${warningText}`));
          } catch (e) {
            return toolError(e);
          }
        }

        case "discard": {
          if (!planName) return toolResult("Error: planName is required.", true);
          const slug = sanitizeFilename(planName);
          try {
            await discardRevision(slug);
            return toolResult(`Draft discarded. Live plan unchanged.`);
          } catch (e) {
            return toolError(e);
          }
        }

        case "rename": {
          if (!planName || !newSlug) return toolResult("Error: planName and newSlug are required.", true);
          const oldSlug = sanitizeFilename(planName);
          const newSlugSanitized = sanitizeFilename(newSlug);
          if (oldSlug === newSlugSanitized) return toolResult("New slug is the same as the old one. No-op.", true);

          const oldDir = getPlanDir(oldSlug);
          const newDir = getPlanDir(newSlugSanitized);
          if (await fs.stat(newDir).then(() => true).catch(() => false)) {
            return toolResult(`Cannot rename: a plan already exists at slug '${newSlugSanitized}'.`, true);
          }
          await fs.rename(oldDir, newDir);
          const planPath = getPlanFile(newSlugSanitized);
          const fileContent = await fs.readFile(planPath, "utf-8");
          const { frontmatter, body } = parseFrontmatter(fileContent);
          const newFm = frontmatter
            ? { ...frontmatter, slug: newSlugSanitized }
            : { title: oldSlug, slug: newSlugSanitized, created: toDateString() };
          await fs.writeFile(planPath, writeFrontmatter(newFm, body));
          await appendChangelogEntry(newSlugSanitized, {
            date: toDateString(),
            title: `renamed from ${oldSlug} to ${newSlugSanitized}`,
            body: "Slug change. No content change.",
          });
          return toolResult(`Renamed plan: '${oldSlug}' → '${newSlugSanitized}'. Update CONTEXT.md if it references the old slug.`);
        }

        case "show": {
          if (!planName) return toolResult("Error: planName is required.", true);
          const slug = sanitizeFilename(planName);
          const draft = await isDraftActive(slug);
          const which = target ?? (draft ? "draft" : "current");
          const filePath = which === "draft"
            ? getDraftPlanFile(slug, await nextDraftVersion(slug))
            : getPlanFile(slug);
          const fileContent = await fs.readFile(filePath, "utf-8");
          return toolResult(`**${slug} — ${which}**\n\n${fileContent}`);
        }

        case "diff": {
          if (!planName) return toolResult("Error: planName is required.", true);
          const slug = sanitizeFilename(planName);
          if (!(await isDraftActive(slug))) return toolResult("No active draft to diff.", true);
          const version = await nextDraftVersion(slug);
          const currentText = await fs.readFile(getPlanFile(slug), "utf-8");
          const draftText = await fs.readFile(getDraftPlanFile(slug, version), "utf-8");
          const rendered = renderDiff(currentText, draftText, { mode: mode ?? "summary" });

          if (inline) return toolResult(rendered);

          const outPath = path.join(getDraftDir(slug, version), "diff.md");
          await fs.writeFile(outPath, rendered);
          return toolResult(`diff written to ${outPath}`);
        }

        default:
          return toolResult(`Unknown action: ${action}`, true);
      }
    } catch (error) {
      return toolError(error);
    }
  }
);

export const dateCalcTool = tool(
  "date_calc",
  "Calculate days and weeks between dates. Use for ANY date arithmetic.",
  {
    target_date: z.string().describe("The target date in YYYY-MM-DD format"),
  },
  async ({ target_date }) => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const target = new Date(target_date);
    target.setHours(0, 0, 0, 0);

    if (isNaN(target.getTime())) {
      return toolResult(JSON.stringify({ error: `Invalid date format: ${target_date}. Use YYYY-MM-DD.` }));
    }

    const diffMs = target.getTime() - today.getTime();
    const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));
    const diffWeeks = Math.round(diffDays / 7);

    const result = {
      today: toDateString(today),
      target_date,
      days_difference: diffDays,
      weeks_difference: diffWeeks,
      is_past: diffDays < 0,
      is_future: diffDays > 0,
      is_today: diffDays === 0,
      human_readable: diffDays === 0
        ? "Today"
        : diffDays < 0
          ? `${Math.abs(diffDays)} days ago (${Math.abs(diffWeeks)} weeks ago)`
          : `${diffDays} days from now (${diffWeeks} weeks away)`,
    };

    return toolResult(JSON.stringify(result, null, 2));
  }
);

export const calculatorTool = tool(
  "calculator",
  "Evaluate mathematical expressions safely.",
  {
    expression: z.string().describe("Mathematical expression to evaluate"),
  },
  async ({ expression }) => {
    const trimmed = expression.trim();
    if (!trimmed) {
      return toolResult(JSON.stringify({ error: "Expression cannot be empty" }));
    }

    try {
      const rawResult = evaluate(trimmed);

      let resultValue: string;
      if (typeof rawResult === "number") {
        if (!Number.isFinite(rawResult)) {
          throw new Error("Invalid calculation result: infinity or NaN");
        }
        resultValue = rawResult.toString();
      } else if (rawResult && typeof (rawResult as { toString?: () => string }).toString === "function") {
        resultValue = (rawResult as { toString: () => string }).toString();
      } else {
        throw new Error("Invalid calculation result type");
      }

      return toolResult(JSON.stringify({ expression: trimmed, result: resultValue }, null, 2));
    } catch (evalError) {
      return toolResult(JSON.stringify({ error: `Invalid expression: ${evalError instanceof Error ? evalError.message : "Unknown error"}` }));
    }
  }
);
