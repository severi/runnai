import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { getWeeklyPlanCompliance } from "../utils/plan-compliance.js";
import { toolResult, toolError } from "../utils/format.js";

export const getPlanComplianceTool = tool(
  "get_plan_compliance",
  "Get structured plan-vs-actual compliance for a training week. Returns each planned session joined to the matching actual run by date, with completion status (completed/missed/upcoming) and a summary. Use this for weekly reviews and to compare a specific run against what was planned. Defaults to the current week.",
  {
    week_number: z
      .number()
      .optional()
      .describe("Plan week number. Omit to use the current week."),
  },
  async ({ week_number }) => {
    try {
      const result = await getWeeklyPlanCompliance(week_number);
      if (!result) {
        return toolResult(
          "No active plan found, or could not determine the requested week. Check that data/plans/ contains a plan file and that today's date falls within a week defined in the plan."
        );
      }
      return toolResult(JSON.stringify(result, null, 2));
    } catch (error) {
      return toolError(error);
    }
  }
);
