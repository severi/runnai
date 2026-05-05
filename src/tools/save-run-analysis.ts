import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { getDb } from "../utils/activities-db.js";
import { toolResult, toolError } from "../utils/format.js";

export const saveRunAnalysisTool = tool(
  "save_run_analysis",
  "Save a coaching analysis for a run. Stores the detailed analysis and optional Strava title. The Strava description is always identical to detailed_analysis (no separate condensed version) — the strava-writeback skill passes the same prose to strava_update_activity.",
  {
    activity_id: z.number().describe("Strava activity ID"),
    detailed_analysis: z.string().describe("Full coaching analysis (1-2 paragraphs). Also used verbatim as the Strava description."),
    strava_title: z.string().optional().describe("Short activity title for Strava"),
  },
  async ({ activity_id, detailed_analysis, strava_title }) => {
    try {
      const db = getDb();
      const now = new Date().toISOString();

      const existing = db.prepare(
        "SELECT activity_id FROM activity_analysis WHERE activity_id = ?"
      ).get(activity_id);

      if (!existing) {
        return toolResult(`No analysis record for activity ${activity_id}. Run get_run_analysis first.`, true);
      }

      // strava_description mirrors detailed_analysis to prevent divergence
      // between what's saved locally and what's published to Strava.
      db.prepare(`
        UPDATE activity_analysis
        SET detailed_analysis = ?, strava_title = ?, strava_description = ?, analysis_generated_at = ?
        WHERE activity_id = ?
      `).run(detailed_analysis, strava_title ?? null, detailed_analysis, now, activity_id);

      return toolResult(JSON.stringify({
        activity_id,
        saved: true,
        has_detailed_analysis: true,
        has_strava_title: !!strava_title,
        saved_at: now,
      }, null, 2));
    } catch (error) {
      return toolError(error);
    }
  }
);
