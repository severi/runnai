import { getDb, saveStreamAnalysis, getActivityStreams, getActivityLaps } from "./activities-db.js";
import { detectHillProfile, classifyRun } from "./run-classifier.js";
import type { ActivityLapRecord, ActivityStream, HrZones, ActivityAnalysisRecord, StreamAnalysisResult, LapSummary, TrainingContext } from "../types/index.js";
import { computeStreamAnalysis } from "./stream-analysis.js";

const CURRENT_ANALYSIS_VERSION = 2;

export function computeActivityAnalysis(
  activityId: number,
  hrZones: HrZones | null,
  easyPaceRef: number,
  streams?: ActivityStream | null
): { analysis: ActivityAnalysisRecord; streamAnalysis: StreamAnalysisResult | null } | null {
  const db = getDb();
  const activity = db.prepare(`
    SELECT id, name, distance, moving_time, average_speed, average_heartrate,
           max_heartrate, workout_type, total_elevation_gain, start_date_local
    FROM activities WHERE id = ?
  `).get(activityId) as {
    id: number; name: string; distance: number; moving_time: number;
    average_speed: number; average_heartrate: number | null;
    max_heartrate: number | null; workout_type: number | null;
    total_elevation_gain: number | null; start_date_local: string;
  } | undefined;
  if (!activity) return null;

  const laps = getActivityLaps(activityId);

  // Load streams from DB if not provided
  if (streams === undefined) {
    streams = getActivityStreams(activityId);
  }

  const grades = streams?.grade_smooth ?? null;

  // Hill profile detection
  const hillProfile = detectHillProfile(laps, activity.distance);

  // Classification with hill awareness
  const classification = classifyRun(
    { id: activity.id, distance: activity.distance, moving_time: activity.moving_time,
      average_speed: activity.average_speed, average_heartrate: activity.average_heartrate,
      workout_type: activity.workout_type },
    laps, hrZones, easyPaceRef, hillProfile
  );

  // Lap summaries
  const lapSummaries: LapSummary[] = laps.map(l => ({
    lap_index: l.lap_index,
    distance_m: l.distance,
    pace_sec_per_km: l.distance > 0 ? (l.moving_time / l.distance) * 1000 : 0,
    elevation_gain: l.elevation_gain,
    elevation_loss: l.elevation_loss,
    avg_heartrate: l.average_heartrate,
  }));

  // Elevation aggregates from laps
  const hasLapElev = laps.some(l => l.elevation_gain !== null);
  const elevGain = hasLapElev
    ? laps.reduce((s, l) => s + (l.elevation_gain ?? 0), 0)
    : activity.total_elevation_gain ?? null;
  const elevLoss = hasLapElev
    ? laps.reduce((s, l) => s + (l.elevation_loss ?? 0), 0)
    : null;

  // Grade-adjusted pace
  const gapSecPerKm = computeGradeAdjustedPace(grades, activity.moving_time, activity.distance);

  // Overall pace
  const paceSecPerKm = activity.distance > 0 ? (activity.moving_time / activity.distance) * 1000 : 0;

  // Comparison context
  const runDate = activity.start_date_local;
  const similarRunType = classification.run_type;

  const sim7d = db.prepare(`
    SELECT COUNT(*) as cnt FROM activities
    WHERE run_type = ? AND type = 'Run' AND trainer = 0
      AND start_date_local >= date(?, '-7 days')
      AND start_date_local < ? AND id != ?
  `).get(similarRunType, runDate, runDate, activityId) as { cnt: number };

  const sim30d = db.prepare(`
    SELECT COUNT(*) as cnt, AVG(moving_time * 1000.0 / distance) as avg_pace
    FROM activities
    WHERE run_type = ? AND type = 'Run' AND trainer = 0
      AND start_date_local >= date(?, '-30 days')
      AND start_date_local < ? AND id != ? AND distance > 0
  `).get(similarRunType, runDate, runDate, activityId) as { cnt: number; avg_pace: number | null };

  // Stream analysis (Tier 1-3 metrics)
  let streamAnalysis: StreamAnalysisResult | null = null;
  if (streams && streams.time.length > 0) {
    try {
      const lapHints = laps.map(l => ({
        start_index: l.start_index,
        end_index: l.end_index,
        distance: l.distance,
      }));
      streamAnalysis = computeStreamAnalysis(streams, hrZones, activity.moving_time, easyPaceRef, lapHints);
      saveStreamAnalysis(activityId, streamAnalysis);
    } catch {
      // Stream analysis is best-effort
    }
  }

  // Use NGP from stream analysis if available (proper Minetti polynomial)
  const gapFromStreams = streamAnalysis?.ngp_sec_per_km ?? null;

  const analysis: ActivityAnalysisRecord = {
    activity_id: activityId,
    run_type: classification.run_type,
    run_type_detail: classification.run_type_detail,
    classification_confidence: classification.confidence,
    hill_category: hillProfile?.category ?? null,
    distance_m: activity.distance,
    moving_time_s: activity.moving_time,
    pace_sec_per_km: paceSecPerKm,
    elevation_gain_m: elevGain,
    elevation_loss_m: elevLoss,
    grade_adjusted_pace_sec_per_km: gapFromStreams ?? gapSecPerKm,
    avg_heartrate: activity.average_heartrate,
    max_heartrate: activity.max_heartrate,
    lap_summaries: lapSummaries,
    similar_runs_7d: sim7d.cnt,
    similar_runs_30d: sim30d.cnt,
    avg_pace_similar_30d: sim30d.avg_pace,
    pace_vs_similar_delta: sim30d.avg_pace != null ? paceSecPerKm - sim30d.avg_pace : null,
    prose_summary: null,
    prose_generated_at: null,
    detailed_analysis: null,
    strava_title: null,
    strava_description: null,
    analysis_generated_at: null,
    analyzed_at: new Date().toISOString(),
    analysis_version: CURRENT_ANALYSIS_VERSION,
  };

  return { analysis, streamAnalysis };
}

function computeGradeAdjustedPace(
  grades: number[] | null,
  movingTimeS: number,
  distanceM: number
): number | null {
  if (!grades || grades.length === 0 || distanceM === 0) return null;
  const avgGrade = grades.reduce((s, g) => s + g, 0) / grades.length;
  const adjustmentFactor = 1 + 0.033 * avgGrade;
  const rawPaceSecPerKm = (movingTimeS / distanceM) * 1000;
  return Math.round((rawPaceSecPerKm / adjustmentFactor) * 10) / 10;
}

export function saveActivityAnalysis(record: ActivityAnalysisRecord): void {
  getDb().prepare(`
    INSERT OR REPLACE INTO activity_analysis (
      activity_id, run_type, run_type_detail, classification_confidence,
      hill_category, distance_m, moving_time_s, pace_sec_per_km,
      elevation_gain_m, elevation_loss_m, grade_adjusted_pace_sec_per_km,
      avg_heartrate, max_heartrate, lap_summaries,
      similar_runs_7d, similar_runs_30d, avg_pace_similar_30d, pace_vs_similar_delta,
      prose_summary, prose_generated_at,
      detailed_analysis, strava_title, strava_description, analysis_generated_at,
      analyzed_at, analysis_version
    ) VALUES (
      $activity_id, $run_type, $run_type_detail, $classification_confidence,
      $hill_category, $distance_m, $moving_time_s, $pace_sec_per_km,
      $elevation_gain_m, $elevation_loss_m, $grade_adjusted_pace_sec_per_km,
      $avg_heartrate, $max_heartrate, $lap_summaries,
      $similar_runs_7d, $similar_runs_30d, $avg_pace_similar_30d, $pace_vs_similar_delta,
      $prose_summary, $prose_generated_at,
      $detailed_analysis, $strava_title, $strava_description, $analysis_generated_at,
      $analyzed_at, $analysis_version
    )
  `).run({
    $activity_id: record.activity_id,
    $run_type: record.run_type,
    $run_type_detail: record.run_type_detail,
    $classification_confidence: record.classification_confidence,
    $hill_category: record.hill_category,
    $distance_m: record.distance_m,
    $moving_time_s: record.moving_time_s,
    $pace_sec_per_km: record.pace_sec_per_km,
    $elevation_gain_m: record.elevation_gain_m,
    $elevation_loss_m: record.elevation_loss_m,
    $grade_adjusted_pace_sec_per_km: record.grade_adjusted_pace_sec_per_km,
    $avg_heartrate: record.avg_heartrate,
    $max_heartrate: record.max_heartrate,
    $lap_summaries: JSON.stringify(record.lap_summaries),
    $similar_runs_7d: record.similar_runs_7d,
    $similar_runs_30d: record.similar_runs_30d,
    $avg_pace_similar_30d: record.avg_pace_similar_30d,
    $pace_vs_similar_delta: record.pace_vs_similar_delta,
    $prose_summary: record.prose_summary,
    $prose_generated_at: record.prose_generated_at,
    $detailed_analysis: record.detailed_analysis,
    $strava_title: record.strava_title,
    $strava_description: record.strava_description,
    $analysis_generated_at: record.analysis_generated_at,
    $analyzed_at: record.analyzed_at,
    $analysis_version: record.analysis_version,
  });
}

export function getActivityAnalysis(activityId: number): ActivityAnalysisRecord | null {
  const row = getDb().prepare(
    "SELECT * FROM activity_analysis WHERE activity_id = ?"
  ).get(activityId) as any;
  if (!row) return null;
  return { ...row, lap_summaries: JSON.parse(row.lap_summaries || "[]") };
}

export function getUnanalyzedActivityIds(limit: number = 50): number[] {
  return (getDb().prepare(`
    SELECT a.id FROM activities a
    LEFT JOIN activity_analysis aa ON a.id = aa.activity_id
    WHERE a.type = 'Run' AND a.trainer = 0 AND a.detail_fetched = 1
      AND aa.activity_id IS NULL
    ORDER BY a.start_date_local DESC LIMIT ?
  `).all(limit) as { id: number }[]).map(r => r.id);
}

export function getRecentUnanalyzedActivityIds(days: number = 7): number[] {
  return (getDb().prepare(`
    SELECT a.id FROM activities a
    LEFT JOIN activity_analysis aa ON a.id = aa.activity_id
    WHERE a.type = 'Run' AND a.trainer = 0 AND a.detail_fetched = 1
      AND aa.activity_id IS NULL
      AND a.start_date_local >= date('now', '-' || ? || ' days')
    ORDER BY a.start_date_local DESC
  `).all(days) as { id: number }[]).map(r => r.id);
}

export function computeTrainingContext(activityId: number): TrainingContext | null {
  const db = getDb();
  const activity = db.prepare(`
    SELECT id, distance, moving_time, total_elevation_gain, start_date_local
    FROM activities WHERE id = ?
  `).get(activityId) as {
    id: number; distance: number; moving_time: number;
    total_elevation_gain: number | null; start_date_local: string;
  } | undefined;
  if (!activity) return null;

  const runDate = activity.start_date_local;

  // Days since last run
  const prevRun = db.prepare(`
    SELECT start_date_local FROM activities
    WHERE type = 'Run' AND trainer = 0
      AND start_date_local < ? AND id != ?
    ORDER BY start_date_local DESC LIMIT 1
  `).get(runDate, activityId) as { start_date_local: string } | undefined;

  const days_since_last_run = prevRun
    ? Math.round((new Date(runDate).getTime() - new Date(prevRun.start_date_local).getTime()) / (1000 * 60 * 60 * 24))
    : null;

  // Runs & km in last 7 days
  const window7d = db.prepare(`
    SELECT COUNT(*) as cnt, COALESCE(SUM(distance), 0) as total_dist FROM activities
    WHERE type = 'Run' AND trainer = 0
      AND start_date_local >= date(?, '-7 days')
      AND start_date_local < ? AND id != ?
  `).get(runDate, runDate, activityId) as { cnt: number; total_dist: number };

  // Runs & km in last 14 days
  const window14d = db.prepare(`
    SELECT COUNT(*) as cnt, COALESCE(SUM(distance), 0) as total_dist FROM activities
    WHERE type = 'Run' AND trainer = 0
      AND start_date_local >= date(?, '-14 days')
      AND start_date_local < ? AND id != ?
  `).get(runDate, runDate, activityId) as { cnt: number; total_dist: number };

  // Longest run in 7d and 30d (other runs, for comparison)
  const longest7d = db.prepare(`
    SELECT MAX(distance) as max_dist FROM activities
    WHERE type = 'Run' AND trainer = 0
      AND start_date_local >= date(?, '-7 days')
      AND start_date_local < ? AND id != ?
  `).get(runDate, runDate, activityId) as { max_dist: number | null };

  const longest30d = db.prepare(`
    SELECT MAX(distance) as max_dist FROM activities
    WHERE type = 'Run' AND trainer = 0
      AND start_date_local >= date(?, '-30 days')
      AND start_date_local < ? AND id != ?
  `).get(runDate, runDate, activityId) as { max_dist: number | null };

  const is_longest_run_7d = longest7d.max_dist != null
    ? activity.distance > longest7d.max_dist
    : true;

  const is_longest_run_30d = longest30d.max_dist != null
    ? activity.distance > longest30d.max_dist
    : true;

  const longest_run_30d_km = longest30d.max_dist != null
    ? Math.round(longest30d.max_dist / 1000 * 100) / 100
    : null;

  // Elevation rank in 30d (1 = most elevation)
  let elevation_rank_30d: number | null = null;
  if (activity.total_elevation_gain != null) {
    const higherCount = db.prepare(`
      SELECT COUNT(*) as cnt FROM activities
      WHERE type = 'Run' AND trainer = 0
        AND start_date_local >= date(?, '-30 days')
        AND start_date_local < ? AND id != ?
        AND total_elevation_gain > ?
    `).get(runDate, runDate, activityId, activity.total_elevation_gain) as { cnt: number };
    elevation_rank_30d = higherCount.cnt + 1;
  }

  // Moving time in minutes
  const moving_time_min = Math.round(activity.moving_time / 60);

  // TRIMP: sum of last 7d (excluding this activity)
  const trimp7d = db.prepare(`
    SELECT SUM(sa.trimp) as total FROM activity_stream_analysis sa
    JOIN activities a ON sa.activity_id = a.id
    WHERE a.type = 'Run' AND a.trainer = 0
      AND a.start_date_local >= date(?, '-7 days')
      AND a.start_date_local < ? AND a.id != ?
      AND sa.trimp IS NOT NULL
  `).get(runDate, runDate, activityId) as { total: number | null };

  const trimp_7d_total = trimp7d.total != null
    ? Math.round(trimp7d.total * 10) / 10
    : null;

  // TRIMP percentile in 30d
  let trimp_percentile_30d: number | null = null;
  const thisTrimp = db.prepare(`
    SELECT trimp FROM activity_stream_analysis WHERE activity_id = ?
  `).get(activityId) as { trimp: number | null } | undefined;

  if (thisTrimp?.trimp != null) {
    const trimpStats = db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN sa.trimp < ? THEN 1 ELSE 0 END) as lower_count
      FROM activity_stream_analysis sa
      JOIN activities a ON sa.activity_id = a.id
      WHERE a.type = 'Run' AND a.trainer = 0
        AND a.start_date_local >= date(?, '-30 days')
        AND a.start_date_local < ? AND a.id != ?
        AND sa.trimp IS NOT NULL
    `).get(thisTrimp.trimp, runDate, runDate, activityId) as { total: number; lower_count: number };

    if (trimpStats.total > 0) {
      trimp_percentile_30d = Math.round(trimpStats.lower_count / trimpStats.total * 100);
    }
  }

  return {
    days_since_last_run,
    runs_last_7d: window7d.cnt,
    km_last_7d: Math.round(window7d.total_dist / 1000 * 100) / 100,
    runs_last_14d: window14d.cnt,
    km_last_14d: Math.round(window14d.total_dist / 1000 * 100) / 100,
    is_longest_run_30d,
    is_longest_run_7d,
    longest_run_30d_km,
    elevation_rank_30d,
    moving_time_min,
    trimp_7d_total,
    trimp_percentile_30d,
  };
}
