/**
 * Heart-rate-only sessions: which activities qualify, how their analysis is
 * stored, and the one ingest step both sync paths and the tool share.
 *
 * "HR session" means an intermittent sport recorded without distance — court
 * and racket sports, team games, untagged gym classes. Runs, rides and lifting
 * are handled elsewhere and are excluded here on purpose: a run has a pace
 * pipeline, a ride is continuous, and lifting HR reflects rest density rather
 * than intensity.
 */

import { getDb, getActivityStreams } from "./activities-db.js";
import { computeHrSessionAnalysis, HR_SESSION_ANALYSIS_VERSION } from "./hr-session-analysis.js";
import type { HrSessionAnalysisResult, HrSessionOptions } from "./hr-session-analysis.js";
import type { ActivityStream, HrZones } from "../types/index.js";

/** Strava sport_type values whose sessions are intermittent and distance-less. */
export const INTERMITTENT_SPORTS = new Set([
  "Basketball", "Tennis", "Badminton", "Padel", "Squash", "Pickleball", "TableTennis", "Racquetball",
  "Soccer", "Floorball", "IceHockey", "Handball", "Volleyball", "Rugby", "Lacrosse",
  "Workout",
]);

/** Outdoor, virtual, e-bike and gravel rides: continuous efforts with distance and often power. */
export function isRide(a: { type: string; sport_type: string }): boolean {
  return a.type === "Ride" || /Ride$/.test(a.sport_type) || a.sport_type === "Velomobile" || a.sport_type === "Handcycle";
}

export function isHrSessionCandidate(a: { type: string; sport_type: string; average_heartrate?: number | null }): boolean {
  if (!a.average_heartrate) return false;
  if (a.type === "Run" || a.sport_type === "Run") return false;
  return INTERMITTENT_SPORTS.has(a.sport_type);
}

export interface HrSessionRecord {
  activity_id: number;
  sport_type: string;
  result: HrSessionAnalysisResult;
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
 * (sync has just fetched them), else the cache. Returns null when there is no
 * heartrate stream or the activity is unknown; stores nothing in that case.
 */
export function ingestHrSession(
  activityId: number,
  zones: HrZones,
  streams?: ActivityStream | null,
  options?: HrSessionOptions,
): HrSessionAnalysisResult | null {
  const db = getDb();
  const activity = db.prepare("SELECT sport_type, type FROM activities WHERE id = ?")
    .get(activityId) as { sport_type: string | null; type: string | null } | undefined;
  if (!activity) return null;

  const s = streams ?? getActivityStreams(activityId);
  if (!s?.heartrate?.length || !s.time?.length) return null;

  const result = computeHrSessionAnalysis({ time: s.time, heartrate: s.heartrate }, zones, options);
  db.prepare(`
    INSERT INTO activity_hr_session_analysis (activity_id, sport_type, result, analysis_version, computed_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(activity_id) DO UPDATE SET
      sport_type = excluded.sport_type,
      result = excluded.result,
      analysis_version = excluded.analysis_version,
      computed_at = excluded.computed_at
  `).run(activityId, activity.sport_type ?? activity.type ?? "Workout", JSON.stringify(result), HR_SESSION_ANALYSIS_VERSION, new Date().toISOString());
  return result;
}

export function getHrSessionAnalysis(activityId: number): HrSessionRecord | null {
  const row = getDb().prepare("SELECT * FROM activity_hr_session_analysis WHERE activity_id = ?")
    .get(activityId) as Row | undefined;
  if (!row) return null;
  return { ...row, result: JSON.parse(row.result) as HrSessionAnalysisResult };
}

export function updateHrSessionDetailedAnalysis(activityId: number, detailedAnalysis: string): boolean {
  const res = getDb().prepare(`
    UPDATE activity_hr_session_analysis
    SET detailed_analysis = ?, analysis_generated_at = ?
    WHERE activity_id = ?
  `).run(detailedAnalysis, new Date().toISOString(), activityId);
  return res.changes > 0;
}

export interface HrSessionSummaryRow {
  activity_id: number;
  name: string | null;
  start_date_local: string;
  duration_s: number;
  avg_hr: number;
  max_hr: number;
  max_hr_pct: number;
  play_avg_hr: number | null;
  play_bouts: number;
  time_above_90pct_s: number;
  trimp: number | null;
  peak_drift_bpm: number | null;
  floor_drift_bpm: number | null;
  mean_floor_hr: number | null;
  detailed_analysis: string | null;
}

/** Earlier analysed sessions of one sport, newest first. */
export function getRecentHrSessions(
  sportType: string,
  opts: { before?: string; exclude?: number; limit?: number } = {},
): HrSessionSummaryRow[] {
  const rows = getDb().prepare(`
    SELECT a.id, a.name, a.start_date_local, h.result, h.detailed_analysis
    FROM activity_hr_session_analysis h
    JOIN activities a ON a.id = h.activity_id
    WHERE h.sport_type = ?
      AND (? IS NULL OR a.start_date_local < ?)
      AND (? IS NULL OR a.id != ?)
    ORDER BY a.start_date_local DESC
    LIMIT ?
  `).all(sportType, opts.before ?? null, opts.before ?? null, opts.exclude ?? null, opts.exclude ?? null, opts.limit ?? 6) as
    { id: number; name: string | null; start_date_local: string; result: string; detailed_analysis: string | null }[];

  return rows.map(r => {
    const res = JSON.parse(r.result) as HrSessionAnalysisResult;
    const floors = res.breaks.filter(b => !b.is_warmup).map(b => b.floor_hr);
    return {
      activity_id: r.id,
      name: r.name,
      start_date_local: r.start_date_local,
      duration_s: res.duration_s,
      avg_hr: res.avg_hr,
      max_hr: res.max_hr,
      max_hr_pct: res.max_hr_pct,
      play_avg_hr: res.play_avg_hr,
      play_bouts: res.bouts.filter(b => !b.is_warmup).length,
      time_above_90pct_s: res.time_above_90pct_s,
      trimp: res.trimp,
      peak_drift_bpm: res.peak_drift_bpm,
      floor_drift_bpm: res.floor_drift_bpm,
      mean_floor_hr: floors.length ? Math.round(floors.reduce((s, v) => s + v, 0) / floors.length) : null,
      detailed_analysis: r.detailed_analysis,
    };
  });
}
