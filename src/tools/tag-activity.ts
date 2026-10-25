import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { getDb, getActivityTags, updateActivityTags, LOAD_TAGS } from "../utils/activities-db.js";
import { toolResult, toolError } from "../utils/format.js";

export const tagActivityTool = tool(
  "tag_activity",
  `Add or remove condition tags on an activity. Tags record what made a run non-comparable to normal running and are stored as a JSON array on the activity. Use whenever the athlete says a run was pushed or carried load, done sick, or otherwise unusual — the aerobic-trend cohort (generate_aerobic_chart) excludes load-tagged runs, and get_run_analysis returns tags so later reads see them. Load tags: ${LOAD_TAGS.join(", ")}. Other useful tags: sick, race, trail-race, run-walk, treadmill-incline, heat, snow. Tags are lower-case kebab-case; free text is accepted. Pass only the tags that change; the rest are kept.`,
  {
    activity_id: z.number().describe("Activity ID"),
    add: z.array(z.string()).optional().describe("Tags to add"),
    remove: z.array(z.string()).optional().describe("Tags to remove"),
  },
  async ({ activity_id, add, remove }) => {
    try {
      const row = getDb().prepare("SELECT id, name, start_date_local FROM activities WHERE id = ?")
        .get(activity_id) as { id: number; name: string; start_date_local: string } | undefined;
      if (!row) return toolResult(`Activity ${activity_id} not found. Run sync_activities first.`, true);
      if (!add?.length && !remove?.length) {
        return toolResult(JSON.stringify({ activity_id, tags: getActivityTags(activity_id) }, null, 2));
      }
      const tags = updateActivityTags(activity_id, add ?? [], remove ?? []);
      return toolResult(JSON.stringify({
        activity_id,
        name: row.name,
        date: row.start_date_local.slice(0, 10),
        tags,
        excluded_from_aerobic_trend: tags.some(t => (LOAD_TAGS as readonly string[]).includes(t)),
      }, null, 2));
    } catch (error) {
      return toolError(error);
    }
  }
);
