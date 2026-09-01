import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { fetchActivityStream } from "../strava/client.js";
import { getDb, getActivityStreams, saveActivityStreams } from "../utils/activities-db.js";
import { loadHrZones } from "../utils/hr-zones.js";
import { HR_SESSION_ANALYSIS_VERSION } from "../utils/hr-session-analysis.js";
import { ingestHrSession, getHrSessionAnalysis, getRecentHrSessions, INTERMITTENT_SPORTS } from "../utils/hr-session.js";
import { toolResult, toolError } from "../utils/format.js";

const optionsSchema = z.object({
  bout_enter_bpm: z.number().optional().describe("Smoothed HR at or above this starts a bout. Default: derived from the session's own HR distribution."),
  bout_exit_bpm: z.number().optional().describe("Smoothed HR below this, held for min_break_s, confirms a break. Default: derived."),
  min_bout_s: z.number().optional().describe("Ignore bouts shorter than this. Default 60."),
  min_break_s: z.number().optional().describe("A dip must last this long to split two bouts. Default 30. Raise it when short changeovers are being counted as breaks."),
}).optional();

export const getSessionAnalysisTool = tool(
  "get_session_analysis",
  "Deterministic analysis for a heart-rate-only session: basketball, tennis, padel, badminton, squash, football and other intermittent sports Strava records without distance. Returns session totals (max HR and % of max, time above 90% of max and above LT2, zones, TRIMP), the detected bouts of play with peak HR each, the breaks between them with floor HR, drop and largest 60 s fall, warm-up flagged separately, and first-half vs second-half drift of peaks and floors. Also returns the previous sessions of the same sport so progression is one call. Bout detection is a heuristic on the HR trace alone: confirm the real format with the athlete (game length, sit-down breaks) and pass `options` to re-cut if the bouts do not match it. Not for runs (use get_run_analysis) or lifting (HR does not reflect intensity there).",
  {
    activity_id: z.number().describe("Strava activity ID"),
    options: optionsSchema.describe("Detection overrides. Passing any option recomputes and stores the result with those thresholds."),
    recompute: z.boolean().optional().describe("Force a recompute with default detection."),
  },
  async ({ activity_id, options, recompute }) => {
    try {
      const db = getDb();
      const activity = db.prepare(
        "SELECT id, name, type, sport_type, start_date_local, elapsed_time, average_heartrate, max_heartrate FROM activities WHERE id = ?"
      ).get(activity_id) as {
        id: number; name: string | null; type: string; sport_type: string; start_date_local: string;
        elapsed_time: number | null; average_heartrate: number | null; max_heartrate: number | null;
      } | undefined;
      if (!activity) return toolResult(`No activity ${activity_id} in the database. Run strava_sync first.`, true);
      if (activity.type === "Run" || activity.sport_type === "Run") {
        return toolResult(`Activity ${activity_id} is a run. Use get_run_analysis for runs; this tool is for heart-rate-only sessions.`, true);
      }
      if (activity.type === "WeightTraining") {
        return toolResult(`Activity ${activity_id} is a strength session. Lifting HR reflects rest density, not intensity, so bout analysis would mislead. Use the strength-fit-import skill instead.`, true);
      }

      const zones = await loadHrZones();
      let record = getHrSessionAnalysis(activity_id);
      const stale = record !== null && record.analysis_version < HR_SESSION_ANALYSIS_VERSION;
      const needsCompute = !record || stale || recompute === true || (options !== undefined && Object.keys(options).length > 0);

      if (needsCompute) {
        let streams = getActivityStreams(activity_id);
        if (!streams) {
          const fetched = await fetchActivityStream(activity_id);
          if (fetched) {
            saveActivityStreams(activity_id, fetched);
            streams = fetched;
          }
        }
        if (!streams?.heartrate?.length) {
          return toolResult(`Activity ${activity_id} has no heart-rate stream on Strava, so there is nothing to analyse beyond duration${activity.average_heartrate ? " and the summary HR" : ""}.`, true);
        }
        const computed = ingestHrSession(activity_id, zones, streams, options);
        if (!computed) return toolResult(`Could not compute an analysis for activity ${activity_id}.`, true);
        record = getHrSessionAnalysis(activity_id)!;
      }

      const previous = getRecentHrSessions(record!.sport_type, {
        before: activity.start_date_local,
        exclude: activity_id,
        limit: 5,
      });

      return toolResult(JSON.stringify({
        activity: {
          id: activity.id,
          name: activity.name,
          sport_type: activity.sport_type,
          known_intermittent_sport: INTERMITTENT_SPORTS.has(activity.sport_type),
          start_date_local: activity.start_date_local,
          elapsed_time_s: activity.elapsed_time,
          strava_avg_hr: activity.average_heartrate,
          strava_max_hr: activity.max_heartrate,
        },
        zones_used: { max_hr: zones.max_hr, lt1: zones.lt1, lt2: zones.lt2, source: zones.source, confirmed: zones.confirmed },
        computed_at: record!.computed_at,
        analysis: record!.result,
        detailed_analysis: record!.detailed_analysis,
        analysis_generated_at: record!.analysis_generated_at,
        previous_sessions: previous,
      }, null, 2));
    } catch (error) {
      return toolError(error);
    }
  }
);
