import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { initDatabase } from "../utils/activities-db.js";

export const saveRunAnalysisTool = tool(
  "save_run_analysis",
  "Save a coaching analysis for a run. Stores the detailed analysis, Strava title, and Strava description in the database. Call this after analyzing a run to persist your analysis for future reference.",
  {
    activity_id: z.number().describe("Strava activity ID"),
    detailed_analysis: z.string().describe("Full coaching analysis (1-2 paragraphs)"),
    strava_title: z.string().optional().describe("Short activity title for Strava"),
    strava_description: z.string().optional().describe("Condensed coaching description for Strava (2-4 sentences)"),
  },
  async ({ activity_id, detailed_analysis, strava_title, strava_description }) => {
    try {
      const db = initDatabase();
      try {
        const now = new Date().toISOString();

        const existing = db.prepare(
          "SELECT activity_id FROM activity_analysis WHERE activity_id = ?"
        ).get(activity_id);

        if (!existing) {
          return {
            content: [{ type: "text" as const, text: `No analysis record for activity ${activity_id}. Run get_run_analysis first.` }],
            isError: true,
          };
        }

        db.prepare(`
          UPDATE activity_analysis
          SET detailed_analysis = ?, strava_title = ?, strava_description = ?, analysis_generated_at = ?
          WHERE activity_id = ?
        `).run(detailed_analysis, strava_title ?? null, strava_description ?? null, now, activity_id);

        return {
          content: [{ type: "text" as const, text: JSON.stringify({
            activity_id,
            saved: true,
            has_detailed_analysis: true,
            has_strava_title: !!strava_title,
            has_strava_description: !!strava_description,
            saved_at: now,
          }, null, 2) }],
        };
      } finally {
        db.close();
      }
    } catch (error) {
      return {
        content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  }
);
