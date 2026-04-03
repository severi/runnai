import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { commitData } from "../utils/data-git.js";
import { toolResult, toolError } from "../utils/format.js";

export const commitDataTool = tool(
  "commit_data",
  "Commit current data changes to git backup. Call when a logical chunk of changes is complete (e.g., after updating a plan, writing memory, saving research). Returns a diff summary so you can verify what changed.",
  {
    message: z.string().describe("Commit message describing what changed (e.g., 'update vienna marathon race week')"),
  },
  async ({ message }) => {
    try {
      const result = await commitData(message);

      if (!result.committed) {
        if (result.error) {
          return toolResult(`Commit failed: ${result.error}`, true);
        }
        return toolResult("Nothing to commit — no data changes since last commit.");
      }

      let text = `Committed: ${result.sha}\n`;
      if (result.summary) {
        text += `\n${result.summary}`;
      }
      return toolResult(text);
    } catch (error) {
      return toolError(error);
    }
  }
);
