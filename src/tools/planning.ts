import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import * as fs from "fs/promises";
import * as path from "path";
import { evaluate } from "mathjs";
import { getDataDir } from "../utils/paths.js";
import { sanitizeFilename, toDateString, toolResult, toolError } from "../utils/format.js";

function getPlansDir(): string {
  return path.join(getDataDir(), "plans");
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
            return toolResult("No training plans found.");
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

          return toolResult(result);
        }

        case "create": {
          if (!planName || !content) {
            return toolResult("Error: planName and content are required.", true);
          }
          const filename = `${sanitizeFilename(planName)}.md`;
          const filePath = path.join(getPlansDir(), filename);

          try {
            await fs.access(filePath);
            return toolResult(`Plan '${planName}' already exists. Use 'update' to modify.`, true);
          } catch {
            // Doesn't exist, proceed
          }

          await fs.writeFile(filePath, content);
          return toolResult(`Created training plan '${planName}'. Saved to: ${filename}`);
        }

        case "read": {
          if (!planName) {
            return toolResult("Error: planName is required.", true);
          }
          const filename = `${sanitizeFilename(planName)}.md`;
          const filePath = path.join(getPlansDir(), filename);

          try {
            const planContent = await fs.readFile(filePath, "utf-8");
            return toolResult(`**Training Plan: ${planName}**\n\n${planContent}`);
          } catch {
            return toolResult(`Plan '${planName}' not found.`, true);
          }
        }

        case "update": {
          if (!planName || !content) {
            return toolResult("Error: planName and content are required.", true);
          }
          const filename = `${sanitizeFilename(planName)}.md`;
          const filePath = path.join(getPlansDir(), filename);

          try {
            await fs.access(filePath);
          } catch {
            return toolResult(`Plan '${planName}' not found. Use 'create'.`, true);
          }

          await fs.writeFile(filePath, content);
          return toolResult(`Updated training plan '${planName}'.`);
        }

        case "delete": {
          if (!planName) {
            return toolResult("Error: planName is required.", true);
          }
          const filename = `${sanitizeFilename(planName)}.md`;
          const filePath = path.join(getPlansDir(), filename);

          try {
            await fs.unlink(filePath);
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
