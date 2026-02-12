import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import * as fs from "fs/promises";
import * as path from "path";
import { evaluate } from "mathjs";
import { getDataDir } from "../utils/paths.js";

function getPlansDir(): string {
  return path.join(getDataDir(), "plans");
}

function sanitizeFilename(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export const planManagerTool = tool(
  "manage_plan",
  "Manage training plans: create, read, update, delete, or list plans.",
  {
    action: z.enum(["create", "read", "update", "delete", "list"]).describe("Action to perform"),
    planName: z.string().optional().describe("Name of the plan"),
    content: z.string().optional().describe("Plan content in markdown"),
  },
  async ({ action, planName, content }) => {
    try {
      await fs.mkdir(getPlansDir(), { recursive: true });

      switch (action) {
        case "list": {
          const files = await fs.readdir(getPlansDir());
          const plans = files.filter((f) => f.endsWith(".md"));

          if (plans.length === 0) {
            return { content: [{ type: "text" as const, text: "No training plans found." }] };
          }

          let result = "**Available Training Plans:**\n\n";
          for (const plan of plans) {
            const filePath = path.join(getPlansDir(), plan);
            const stat = await fs.stat(filePath);
            const fileContent = await fs.readFile(filePath, "utf-8");
            const firstLine = fileContent.split("\n")[0].replace(/^#\s*/, "");
            result += `- **${plan.replace(".md", "")}**: ${firstLine}\n`;
            result += `  Last modified: ${stat.mtime.toLocaleDateString()}\n`;
          }

          return { content: [{ type: "text" as const, text: result }] };
        }

        case "create": {
          if (!planName || !content) {
            return { content: [{ type: "text" as const, text: "Error: planName and content are required." }], isError: true };
          }
          const filename = `${sanitizeFilename(planName)}.md`;
          const filePath = path.join(getPlansDir(), filename);

          try {
            await fs.access(filePath);
            return { content: [{ type: "text" as const, text: `Plan '${planName}' already exists. Use 'update' to modify.` }], isError: true };
          } catch {
            // Doesn't exist, proceed
          }

          await fs.writeFile(filePath, content);
          return { content: [{ type: "text" as const, text: `Created training plan '${planName}'. Saved to: ${filename}` }] };
        }

        case "read": {
          if (!planName) {
            return { content: [{ type: "text" as const, text: "Error: planName is required." }], isError: true };
          }
          const filename = `${sanitizeFilename(planName)}.md`;
          const filePath = path.join(getPlansDir(), filename);

          try {
            const planContent = await fs.readFile(filePath, "utf-8");
            return { content: [{ type: "text" as const, text: `**Training Plan: ${planName}**\n\n${planContent}` }] };
          } catch {
            return { content: [{ type: "text" as const, text: `Plan '${planName}' not found.` }], isError: true };
          }
        }

        case "update": {
          if (!planName || !content) {
            return { content: [{ type: "text" as const, text: "Error: planName and content are required." }], isError: true };
          }
          const filename = `${sanitizeFilename(planName)}.md`;
          const filePath = path.join(getPlansDir(), filename);

          try {
            await fs.access(filePath);
          } catch {
            return { content: [{ type: "text" as const, text: `Plan '${planName}' not found. Use 'create'.` }], isError: true };
          }

          await fs.writeFile(filePath, content);
          return { content: [{ type: "text" as const, text: `Updated training plan '${planName}'.` }] };
        }

        case "delete": {
          if (!planName) {
            return { content: [{ type: "text" as const, text: "Error: planName is required." }], isError: true };
          }
          const filename = `${sanitizeFilename(planName)}.md`;
          const filePath = path.join(getPlansDir(), filename);

          try {
            await fs.unlink(filePath);
            return { content: [{ type: "text" as const, text: `Deleted training plan '${planName}'.` }] };
          } catch {
            return { content: [{ type: "text" as const, text: `Plan '${planName}' not found.` }], isError: true };
          }
        }

        default:
          return { content: [{ type: "text" as const, text: `Unknown action: ${action}` }], isError: true };
      }
    } catch (error) {
      return {
        content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
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
      return { content: [{ type: "text" as const, text: JSON.stringify({ error: `Invalid date format: ${target_date}. Use YYYY-MM-DD.` }) }] };
    }

    const diffMs = target.getTime() - today.getTime();
    const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));
    const diffWeeks = Math.round(diffDays / 7);

    const result = {
      today: today.toISOString().split("T")[0],
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

    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
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
      return { content: [{ type: "text" as const, text: JSON.stringify({ error: "Expression cannot be empty" }) }] };
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

      return { content: [{ type: "text" as const, text: JSON.stringify({ expression: trimmed, result: resultValue }, null, 2) }] };
    } catch (evalError) {
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ error: `Invalid expression: ${evalError instanceof Error ? evalError.message : "Unknown error"}` }),
        }],
      };
    }
  }
);
