import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { getDb } from "../utils/activities-db.js";
import { toolResult, toolError } from "../utils/format.js";
import { getHrSessionAnalysis, updateHrSessionDetailedAnalysis } from "../utils/hr-session.js";
import { getCrossTrainingAnalysis, updateCrossTrainingDetailedAnalysis } from "../utils/cross-training.js";
import { isStrengthSession } from "../utils/hr-session.js";
import { saveStrengthAnalysis } from "../utils/strength-session.js";

export const saveRunAnalysisTool = tool(
  "save_run_analysis",
  "Save a coaching analysis for a run, or the `detailed_analysis` of a heart-rate-only session analysed with get_session_analysis, a cross-training session analysed with get_cross_training_analysis, or a strength session (WeightTraining, Crossfit) whose read comes from the FIT import or the athlete's own numbers — call it BEFORE posting the read, so the analysis survives even if the session ends on the follow-up question. `detailed_analysis` is the thorough private coaching read (depth, plan-vs-actual, training-load context, mistakes/learnings, what-to-do-next, cross-run comparisons if relevant). `strava_description` is the optional public-feed version — set it ONLY when pushing to Strava (typically via the strava-writeback skill); leave undefined to keep the existing strava_description. The two are stored separately and intentionally diverge.",
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
        // Heart-rate-only sessions (basketball, tennis, ...) keep their coaching
        // read on their own record. Strava writeback is a run flow, so only the
        // private analysis is accepted for them.
        const session = getHrSessionAnalysis(activity_id);
        if (session) {
          if (strava_title !== undefined || strava_description !== undefined) {
            return toolResult(`Activity ${activity_id} is a ${session.sport_type} session, not a run: strava_title and strava_description are not supported for it. Save detailed_analysis only.`, true);
          }
          if (detailed_analysis === undefined) {
            return toolResult(`No detailed_analysis provided for session ${activity_id}.`, true);
          }
          updateHrSessionDetailedAnalysis(activity_id, detailed_analysis);
          return toolResult(JSON.stringify({ activity_id, saved: true, kind: "hr_session", updated_detailed_analysis: true, saved_at: now }, null, 2));
        }
        const cross = getCrossTrainingAnalysis(activity_id);
        if (cross) {
          if (strava_title !== undefined || strava_description !== undefined) {
            return toolResult(`Activity ${activity_id} is a ${cross.sport_type} session, not a run: strava_title and strava_description are not supported for it. Save detailed_analysis only.`, true);
          }
          if (detailed_analysis === undefined) {
            return toolResult(`No detailed_analysis provided for session ${activity_id}.`, true);
          }
          updateCrossTrainingDetailedAnalysis(activity_id, detailed_analysis);
          return toolResult(JSON.stringify({ activity_id, saved: true, kind: "cross_training", updated_detailed_analysis: true, saved_at: now }, null, 2));
        }
        // Strength sessions have no computed record; the read itself is the record.
        const kind = db.prepare("SELECT type, sport_type, average_heartrate FROM activities WHERE id = ?")
          .get(activity_id) as { type: string; sport_type: string; average_heartrate: number | null } | undefined;
        if (kind && isStrengthSession(kind)) {
          if (strava_title !== undefined || strava_description !== undefined) {
            return toolResult(`Activity ${activity_id} is a ${kind.sport_type} session, not a run: strava_title and strava_description are not supported for it. Save detailed_analysis only.`, true);
          }
          if (detailed_analysis === undefined) {
            return toolResult(`No detailed_analysis provided for session ${activity_id}.`, true);
          }
          saveStrengthAnalysis(activity_id, detailed_analysis);
          return toolResult(JSON.stringify({ activity_id, saved: true, kind: "strength", updated_detailed_analysis: true, saved_at: now }, null, 2));
        }
        return toolResult(`No analysis record for activity ${activity_id}. Run get_run_analysis first (or get_session_analysis for a heart-rate-only session, get_cross_training_analysis for a ride or other continuous cross-training).`, true);
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
