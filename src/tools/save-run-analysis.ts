import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { getDb } from "../utils/activities-db.js";
import { toolResult, toolError } from "../utils/format.js";

export const saveRunAnalysisTool = tool(
  "save_run_analysis",
  "Save a coaching analysis for a run. `detailed_analysis` is the thorough private coaching read (depth, plan-vs-actual, training-load context, mistakes/learnings, what-to-do-next, cross-run comparisons if relevant). `strava_description` is the optional public-feed version — set it ONLY when pushing to Strava (typically via the strava-writeback skill); leave undefined to keep the existing strava_description. The two are stored separately and intentionally diverge.",
  {
    activity_id: z.number().describe("Strava activity ID"),
    detailed_analysis: z.string().optional().describe("Thorough private coaching analysis. Plan-aware, includes context, comparisons, and actionable takeaways. NOT for public consumption. Pass undefined to leave existing detailed_analysis untouched."),
    strava_title: z.string().optional().describe("Short activity title for Strava. Pass undefined to leave existing title untouched."),
    strava_description: z.string().optional().describe("Public-facing Strava description, derived from but distinct from detailed_analysis. Tight what-happened account, no plan/future/orthogonal content. Pass undefined to leave existing description untouched."),
  },
  async ({ activity_id, detailed_analysis, strava_title, strava_description }) => {
    try {
      const db = getDb();
      const now = new Date().toISOString();

      const existing = db.prepare(
        "SELECT activity_id FROM activity_analysis WHERE activity_id = ?"
      ).get(activity_id);

      if (!existing) {
        return toolResult(`No analysis record for activity ${activity_id}. Run get_run_analysis first.`, true);
      }

      if (detailed_analysis === undefined && strava_title === undefined && strava_description === undefined) {
        return toolResult(`No fields provided for activity ${activity_id}. Pass at least one of detailed_analysis, strava_title, strava_description.`, true);
      }

      const sets: string[] = [];
      const params: (string | number | null)[] = [];

      if (detailed_analysis !== undefined) {
        sets.push("detailed_analysis = ?");
        params.push(detailed_analysis);
      }
      if (strava_title !== undefined) {
        sets.push("strava_title = ?");
        params.push(strava_title);
      }
      if (strava_description !== undefined) {
        sets.push("strava_description = ?");
        params.push(strava_description);
      }
      sets.push("analysis_generated_at = ?");
      params.push(now);
      params.push(activity_id);

      db.prepare(`
        UPDATE activity_analysis
        SET ${sets.join(", ")}
        WHERE activity_id = ?
      `).run(...params);

      return toolResult(JSON.stringify({
        activity_id,
        saved: true,
        updated_detailed_analysis: detailed_analysis !== undefined,
        updated_strava_title: strava_title !== undefined,
        updated_strava_description: strava_description !== undefined,
        saved_at: now,
      }, null, 2));
    } catch (error) {
      return toolError(error);
    }
  }
);
