/**
 * Continuous cross-training sessions: rides (outdoor, virtual, trainer),
 * walks, hikes, ski, rowing, swimming — every activity that is neither a run,
 * an intermittent heart-rate session nor a lift. Sport predicate, persistence
 * in `activity_cross_training_analysis`, ingest from the stream cache, and
 * same-sport history for comparison.
 */

import { getDb, getActivityStreams } from "./activities-db.js";
import type { ActivityStream, HrZones } from "../types/index.js";
import { isHrSessionCandidate, isStrengthSession } from "./hr-session.js";
import {
  computeCrossTrainingAnalysis,
  CROSS_TRAINING_ANALYSIS_VERSION,
  type CrossTrainingAnalysisResult,
} from "./cross-training-analysis.js";

/**
 * Everything continuous that is not a run: rides of every kind, walks, hikes,
 * ski, swims, rowing, elliptical. Trainer runs stay with the run pipeline.
 */
export function isCrossTrainingCandidate(a: { type: string; sport_type: string; average_heartrate?: number | null }): boolean {
  if (a.type === "Run" || a.sport_type === "Run") return false;
  if (isHrSessionCandidate(a)) return false;
  if (isStrengthSession(a)) return false;
  return true;
}

export interface CrossTrainingRecord {
  activity_id: number;
  sport_type: string;
  result: CrossTrainingAnalysisResult;
  analysis_version: number;
  computed_at: string;
  detailed_analysis: string | null;
  analysis_generated_at: string | null;
}

interface Row {
  activity_id: number;
  sport_type: string;
  result: string;
  analysis_version: number;
  computed_at: string;
  detailed_analysis: string | null;
  analysis_generated_at: string | null;
}

/**
 * Compute and store the analysis for one activity. Uses `streams` when given
 * (sync has just fetched them), else the cache. Returns null when there is
 * neither a heart-rate nor a power stream, or the activity is unknown; stores
 * nothing in that case. `detailed_analysis` survives a recompute.
 */
export function ingestCrossTraining(
  activityId: number,
  zones: HrZones,
  streams?: ActivityStream | null,
): CrossTrainingAnalysisResult | null {
  const db = getDb();
  const activity = db.prepare("SELECT sport_type, type FROM activities WHERE id = ?")
    .get(activityId) as { sport_type: string | null; type: string | null } | undefined;
  if (!activity) return null;

  const s = streams ?? getActivityStreams(activityId);
  if (!s?.time?.length) return null;
  if (!s.heartrate?.length && !s.watts?.length) return null;

  const result = computeCrossTrainingAnalysis(
    { time: s.time, heartrate: s.heartrate, watts: s.watts, cadence: s.cadence },
    zones,
  );
  db.prepare(`
    INSERT INTO activity_cross_training_analysis (activity_id, sport_type, result, analysis_version, computed_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(activity_id) DO UPDATE SET
      sport_type = excluded.sport_type,
      result = excluded.result,
      analysis_version = excluded.analysis_version,
      computed_at = excluded.computed_at
  `).run(activityId, activity.sport_type ?? activity.type ?? "Workout", JSON.stringify(result), CROSS_TRAINING_ANALYSIS_VERSION, new Date().toISOString());
  return result;
}

export function getCrossTrainingAnalysis(activityId: number): CrossTrainingRecord | null {
  const row = getDb().prepare("SELECT * FROM activity_cross_training_analysis WHERE activity_id = ?")
    .get(activityId) as Row | undefined;
  if (!row) return null;
  return { ...row, result: JSON.parse(row.result) as CrossTrainingAnalysisResult };
}

export function updateCrossTrainingDetailedAnalysis(activityId: number, detailedAnalysis: string): boolean {
  const res = getDb().prepare(`
    UPDATE activity_cross_training_analysis
    SET detailed_analysis = ?, analysis_generated_at = ?
    WHERE activity_id = ?
  `).run(detailedAnalysis, new Date().toISOString(), activityId);
  return res.changes > 0;
}

/**
 * Analyse earlier sessions of one sport whose streams are already cached but
 * that have no record yet (streams fetched before this layer existed, or by
 * get_activity_streams). No network: history is fetched on demand only when
 * the coach asks about a specific older session.
 */
export function backfillCrossTrainingFromCache(sportType: string, zones: HrZones, limit = 5): number {
  const ids = getDb().prepare(`
    SELECT a.id FROM activities a
    JOIN activity_streams s ON s.activity_id = a.id
    LEFT JOIN activity_cross_training_analysis c ON c.activity_id = a.id
    WHERE a.sport_type = ? AND c.activity_id IS NULL
    ORDER BY a.start_date_local DESC
    LIMIT ?
  `).all(sportType, limit) as { id: number }[];
  let n = 0;
  for (const { id } of ids) if (ingestCrossTraining(id, zones)) n++;
  return n;
}

export interface CrossTrainingSummaryRow {
  activity_id: number;
  name: string | null;
  start_date_local: string;
  duration_s: number;
  distance_m: number;
  elevation_gain_m: number | null;
  trainer: boolean;
  avg_hr: number | null;
  max_hr: number | null;
  trimp: number | null;
  hr_drift_pct: number | null;
  avg_watts: number | null;
  normalized_watts: number | null;
  variability_index: number | null;
  p20m_watts: number | null;
  decoupling_pct: number | null;
  work_kj: number | null;
  detailed_analysis: string | null;
}

/** Earlier analysed sessions of one sport, newest first. */
export function getRecentCrossTraining(
  sportType: string,
  opts: { before?: string; exclude?: number; limit?: number } = {},
): CrossTrainingSummaryRow[] {
  const rows = getDb().prepare(`
    SELECT a.id, a.name, a.start_date_local, a.distance, a.total_elevation_gain, a.trainer, c.result, c.detailed_analysis
    FROM activity_cross_training_analysis c
    JOIN activities a ON a.id = c.activity_id
    WHERE c.sport_type = ?
      AND (? IS NULL OR a.start_date_local < ?)
      AND (? IS NULL OR a.id != ?)
    ORDER BY a.start_date_local DESC
    LIMIT ?
  `).all(sportType, opts.before ?? null, opts.before ?? null, opts.exclude ?? null, opts.exclude ?? null, opts.limit ?? 6) as
    { id: number; name: string | null; start_date_local: string; distance: number | null; total_elevation_gain: number | null; trainer: number | null; result: string; detailed_analysis: string | null }[];

  return rows.map(r => {
    const res = JSON.parse(r.result) as CrossTrainingAnalysisResult;
    return {
      activity_id: r.id,
      name: r.name,
      start_date_local: r.start_date_local,
      duration_s: res.duration_s,
      distance_m: r.distance ?? 0,
      elevation_gain_m: r.total_elevation_gain,
      trainer: r.trainer === 1,
      avg_hr: res.hr?.avg ?? null,
      max_hr: res.hr?.max ?? null,
      trimp: res.hr?.trimp ?? null,
      hr_drift_pct: res.hr?.drift_pct ?? null,
      avg_watts: res.power?.avg_watts ?? null,
      normalized_watts: res.power?.normalized_watts ?? null,
      variability_index: res.power?.variability_index ?? null,
      p20m_watts: res.power?.peaks.p20m_watts ?? null,
      decoupling_pct: res.power?.decoupling_pct ?? null,
      work_kj: res.power?.work_kj ?? null,
      detailed_analysis: r.detailed_analysis,
    };
  });
}
