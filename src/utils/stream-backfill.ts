import { getDb, getActivityStreams, getActivityLaps, saveStreamAnalysis } from "./activities-db.js";
import { computeStreamAnalysis, STREAM_ANALYSIS_VERSION } from "./stream-analysis.js";
import { loadHrZones, computeEasyPaceRef } from "./hr-zones.js";
import type { DistanceActivityStream, HrZones } from "../types/index.js";

/**
 * Stream analysis (NGP, efficiency factor, drift, phases) is normally computed
 * when a run is read with get_run_analysis or lands in the last-7-days startup
 * window. Runs older than that — the whole winter of 2025/26 on the first
 * install — never got a row, so every long-horizon trend query silently lost
 * its grade-adjusted efficiency factor for those months. This module fills the
 * gap from the streams already in the DB. It writes ONLY activity_stream_analysis:
 * run_type, the activity_analysis record and any coaching prose are untouched.
 */

export interface BackfillResult {
  /** Runs that had streams but no current-version stream analysis. */
  candidates: number;
  computed: number;
  /** Streams without a distance series, or that threw during analysis. */
  skipped: number;
  /** Candidates left untouched because `limit` was reached. */
  remaining: number;
}

export function getRunsMissingStreamAnalysis(limit: number): number[] {
  return (getDb().prepare(
    `SELECT a.id FROM activities a
     JOIN activity_streams st ON st.activity_id = a.id
     LEFT JOIN activity_stream_analysis s ON s.activity_id = a.id
     WHERE a.type = 'Run'
       AND st.distance_data IS NOT NULL
       AND (s.activity_id IS NULL OR s.stream_analysis_version < ?)
     ORDER BY a.start_date_local DESC
     LIMIT ?`
  ).all(STREAM_ANALYSIS_VERSION, limit) as { id: number }[]).map(r => r.id);
}

export function countRunsMissingStreamAnalysis(): number {
  const row = getDb().prepare(
    `SELECT COUNT(*) AS n FROM activities a
     JOIN activity_streams st ON st.activity_id = a.id
     LEFT JOIN activity_stream_analysis s ON s.activity_id = a.id
     WHERE a.type = 'Run' AND st.distance_data IS NOT NULL
       AND (s.activity_id IS NULL OR s.stream_analysis_version < ?)`
  ).get(STREAM_ANALYSIS_VERSION) as { n: number };
  return row.n;
}

/** Compute and store stream analysis for one run. Returns false when it has no paced stream. */
export function backfillOne(activityId: number, hrZones: HrZones | null, easyPaceRef: number): boolean {
  const activity = getDb().prepare("SELECT moving_time FROM activities WHERE id = ?")
    .get(activityId) as { moving_time: number } | undefined;
  if (!activity) return false;
  const streams = getActivityStreams(activityId);
  if (!streams || streams.time.length === 0 || !streams.distance?.length) return false;
  const laps = getActivityLaps(activityId).map(l => ({
    start_index: l.start_index,
    end_index: l.end_index,
    distance: l.distance,
  }));
  const result = computeStreamAnalysis(
    streams as DistanceActivityStream, hrZones, activity.moving_time, easyPaceRef, laps
  );
  saveStreamAnalysis(activityId, result);
  return true;
}

export async function backfillStreamAnalysis(limit: number = 500): Promise<BackfillResult> {
  const total = countRunsMissingStreamAnalysis();
  const ids = getRunsMissingStreamAnalysis(limit);
  const zones = await loadHrZones();
  const hrZones = zones.confirmed ? zones : null;
  const easyPaceRef = computeEasyPaceRef();

  let computed = 0;
  let skipped = 0;
  for (const id of ids) {
    try {
      if (backfillOne(id, hrZones, easyPaceRef)) computed++;
      else skipped++;
    } catch {
      skipped++;
    }
  }
  return { candidates: total, computed, skipped, remaining: Math.max(0, total - ids.length) };
}
