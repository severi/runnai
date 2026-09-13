import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { fetchActivityStream } from "../strava/client.js";
import { getDb, getActivityStreams, saveActivityStreams } from "../utils/activities-db.js";
import { loadHrZones } from "../utils/hr-zones.js";
import { CROSS_TRAINING_ANALYSIS_VERSION } from "../utils/cross-training-analysis.js";
import { ingestCrossTraining, getCrossTrainingAnalysis, getRecentCrossTraining, backfillCrossTrainingFromCache } from "../utils/cross-training.js";
import { isHrSessionCandidate, isStrengthSession } from "../utils/hr-session.js";
import { toolResult, toolError } from "../utils/format.js";
import { athleteNotesFromDescription } from "../utils/athlete-notes.js";

export const getCrossTrainingAnalysisTool = tool(
  "get_cross_training_analysis",
  "Deterministic analysis for a continuous cross-training session: rides (outdoor, virtual, trainer, with or without power), walks, hikes, ski, rowing, swimming and similar. Returns heart-rate load (avg, max and % of max, zones, TRIMP, time above LT1/LT2, first-half vs second-half drift) and, when the ride carries a power stream, average and normalized power, variability index, work in kJ, coasting share, 5 s / 1 min / 5 min / 20 min peaks, a 20-minute-based FTP ballpark, and aerobic decoupling (Pw:Hr first half vs second). Also returns Strava's summary power fields, the athlete's own description as athlete_notes, and the previous sessions of the same sport so progression is one call. Not for runs (get_run_analysis), intermittent sports (get_session_analysis) or lifting (strength-fit-import skill).",
  {
    activity_id: z.number().describe("Strava activity ID"),
    recompute: z.boolean().optional().describe("Force a recompute from the cached stream."),
  },
  async ({ activity_id, recompute }) => {
    try {
      const db = getDb();
      const activity = db.prepare(
        `SELECT id, name, type, sport_type, start_date_local, distance, moving_time, elapsed_time, total_elevation_gain, trainer,
                average_heartrate, max_heartrate, description,
                average_watts, weighted_average_watts, max_watts, kilojoules, device_watts
         FROM activities WHERE id = ?`
      ).get(activity_id) as {
        id: number; name: string | null; type: string; sport_type: string; start_date_local: string;
        distance: number | null; moving_time: number | null; elapsed_time: number | null; total_elevation_gain: number | null;
        trainer: number | null; average_heartrate: number | null; max_heartrate: number | null; description: string | null;
        average_watts: number | null; weighted_average_watts: number | null; max_watts: number | null;
        kilojoules: number | null; device_watts: number | null;
      } | undefined;
      if (!activity) return toolResult(`No activity ${activity_id} in the database. Run strava_sync first.`, true);
      if (activity.type === "Run" || activity.sport_type === "Run") {
        return toolResult(`Activity ${activity_id} is a run. Use get_run_analysis for runs; this tool is for continuous cross-training.`, true);
      }
      if (isHrSessionCandidate(activity)) {
        return toolResult(`Activity ${activity_id} is a ${activity.sport_type} session, an intermittent sport. Use get_session_analysis, which cuts it into bouts and breaks.`, true);
      }
      if (isStrengthSession(activity)) {
        return toolResult(`Activity ${activity_id} is a strength session. Lifting HR reflects rest density, not intensity, so a continuous-load read would mislead. Use the strength-fit-import skill instead.`, true);
      }

      const zones = await loadHrZones();
      let record = getCrossTrainingAnalysis(activity_id);
      const stale = record !== null && record.analysis_version < CROSS_TRAINING_ANALYSIS_VERSION;

      if (!record || stale || recompute === true) {
        let streams = getActivityStreams(activity_id);
        if (!streams) {
          const fetched = await fetchActivityStream(activity_id);
          if (fetched) {
            saveActivityStreams(activity_id, fetched);
            streams = fetched;
          }
        }
        if (!streams?.heartrate?.length && !streams?.watts?.length) {
          return toolResult(`Activity ${activity_id} has no heart-rate or power stream on Strava, so there is nothing to analyse beyond duration${activity.distance ? ", distance" : ""}${activity.average_heartrate ? " and the summary HR" : ""}.`, true);
        }
        const computed = ingestCrossTraining(activity_id, zones, streams);
        if (!computed) return toolResult(`Could not compute an analysis for activity ${activity_id}.`, true);
        record = getCrossTrainingAnalysis(activity_id)!;
      }

      // Earlier same-sport sessions with a cached stream but no record yet
      // (no network) so the comparison is not empty on the first read.
      backfillCrossTrainingFromCache(record!.sport_type, zones);
      const previous = getRecentCrossTraining(record!.sport_type, {
        before: activity.start_date_local,
        exclude: activity_id,
        limit: 5,
      });

      const hasSummaryPower = activity.average_watts != null;
      return toolResult(JSON.stringify({
        activity: {
          id: activity.id,
          name: activity.name,
          sport_type: activity.sport_type,
          start_date_local: activity.start_date_local,
          // Trainer / virtual: distance and speed are simulated, do not read them as terrain.
          trainer: activity.trainer === 1,
          distance_m: activity.distance,
          moving_time_s: activity.moving_time,
          elapsed_time_s: activity.elapsed_time,
          elevation_gain_m: activity.total_elevation_gain,
          strava_avg_hr: activity.average_heartrate,
          strava_max_hr: activity.max_heartrate,
          strava_power: hasSummaryPower ? {
            average_watts: activity.average_watts,
            weighted_average_watts: activity.weighted_average_watts,
            max_watts: activity.max_watts,
            kilojoules: activity.kilojoules,
            // true = a power meter or smart trainer; false = Strava's estimate from speed and grade.
            device_watts: activity.device_watts === 1,
          } : null,
          // The athlete's own Strava description, verbatim. Quote it as their account, never grade it.
          athlete_notes: athleteNotesFromDescription(activity.description),
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
