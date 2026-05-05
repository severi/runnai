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
  getDraftPlanFile,
  getDraftReasoningFile,
  getDraftMarker,
  isDraftActive,
  listPlanSlugs,
  nextDraftVersion,
} from "../utils/plan-paths.js";
import { writeFrontmatter, parseFrontmatter } from "../utils/plan-frontmatter.js";
import { appendChangelogEntry } from "../utils/plan-changelog.js";
import { appendToSection } from "../utils/plan-reasoning.js";

export const planManagerTool = tool(
  "manage_plan",
  "Manage training plans: create, read, update, delete, or list plans.",
  {
    action: z.enum(["create", "read", "update", "delete", "list"]).describe("Action to perform"),
    planName: z.string().optional().describe("Name of the plan"),
    content: z.string().optional().describe("Full plan content in markdown. For 'update', this REPLACES the entire file — pass the complete plan, not a partial patch."),
  },
  async ({ action, planName, content }) => {
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
