import { Database } from "bun:sqlite";
import Anthropic from "@anthropic-ai/sdk";
import { initDatabase } from "./activities-db.js";
import { detectHillProfile, classifyRun } from "./run-classifier.js";
import type { ActivityLapRecord, ActivityStream, HrZones, ActivityAnalysisRecord, StreamAnalysisResult, LapSummary } from "../types/index.js";
import { computeStreamAnalysis } from "./stream-analysis.js";
import { saveStreamAnalysis } from "./activities-db.js";

const CURRENT_ANALYSIS_VERSION = 2;

export function computeActivityAnalysis(
  activityId: number,
  db: Database,
  hrZones: HrZones | null,
  easyPaceRef: number,
  streams?: ActivityStream | null
): { analysis: ActivityAnalysisRecord; streamAnalysis: StreamAnalysisResult | null } | null {
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

  const laps = db.prepare(
    "SELECT * FROM activity_laps WHERE activity_id = ? ORDER BY lap_index ASC"
  ).all(activityId) as ActivityLapRecord[];

  // Load streams from DB if not provided
  if (streams === undefined) {
    const row = db.prepare("SELECT * FROM activity_streams WHERE activity_id = ?").get(activityId) as any;
    if (row) {
      streams = {
        time: JSON.parse(row.time_data),
        distance: JSON.parse(row.distance_data),
        heartrate: row.heartrate_data ? JSON.parse(row.heartrate_data) : undefined,
        altitude: row.altitude_data ? JSON.parse(row.altitude_data) : undefined,
        grade_smooth: row.grade_smooth_data ? JSON.parse(row.grade_smooth_data) : undefined,
        cadence: row.cadence_data ? JSON.parse(row.cadence_data) : undefined,
      };
    }
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
      saveStreamAnalysis(activityId, streamAnalysis, db);
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

export function saveActivityAnalysis(record: ActivityAnalysisRecord, db: Database): void {
  db.prepare(`
    INSERT OR REPLACE INTO activity_analysis (
      activity_id, run_type, run_type_detail, classification_confidence,
      hill_category, distance_m, moving_time_s, pace_sec_per_km,
      elevation_gain_m, elevation_loss_m, grade_adjusted_pace_sec_per_km,
      avg_heartrate, max_heartrate, lap_summaries,
      similar_runs_7d, similar_runs_30d, avg_pace_similar_30d, pace_vs_similar_delta,
      prose_summary, prose_generated_at, analyzed_at, analysis_version
    ) VALUES (
      $activity_id, $run_type, $run_type_detail, $classification_confidence,
      $hill_category, $distance_m, $moving_time_s, $pace_sec_per_km,
      $elevation_gain_m, $elevation_loss_m, $grade_adjusted_pace_sec_per_km,
      $avg_heartrate, $max_heartrate, $lap_summaries,
      $similar_runs_7d, $similar_runs_30d, $avg_pace_similar_30d, $pace_vs_similar_delta,
      $prose_summary, $prose_generated_at, $analyzed_at, $analysis_version
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
    $analyzed_at: record.analyzed_at,
    $analysis_version: record.analysis_version,
  });
}

export function getActivityAnalysis(activityId: number, db?: Database): ActivityAnalysisRecord | null {
  const ownDb = !db;
  const d = db ?? initDatabase();
  try {
    const row = d.prepare(
      "SELECT * FROM activity_analysis WHERE activity_id = ?"
    ).get(activityId) as any;
    if (!row) return null;
    return { ...row, lap_summaries: JSON.parse(row.lap_summaries || "[]") };
  } finally {
    if (ownDb) d.close();
  }
}

export function getUnanalyzedActivityIds(db: Database, limit: number = 50): number[] {
  return (db.prepare(`
    SELECT a.id FROM activities a
    LEFT JOIN activity_analysis aa ON a.id = aa.activity_id
    WHERE a.type = 'Run' AND a.trainer = 0 AND a.detail_fetched = 1
      AND aa.activity_id IS NULL
    ORDER BY a.start_date_local DESC LIMIT ?
  `).all(limit) as { id: number }[]).map(r => r.id);
}

export function getRecentUnanalyzedActivityIds(db: Database, days: number = 7): number[] {
  return (db.prepare(`
    SELECT a.id FROM activities a
    LEFT JOIN activity_analysis aa ON a.id = aa.activity_id
    WHERE a.type = 'Run' AND a.trainer = 0 AND a.detail_fetched = 1
      AND aa.activity_id IS NULL
      AND a.start_date_local >= date('now', '-' || ? || ' days')
    ORDER BY a.start_date_local DESC
  `).all(days) as { id: number }[]).map(r => r.id);
}

export function formatPace(secPerKm: number): string {
  const min = Math.floor(secPerKm / 60);
  const sec = Math.round(secPerKm % 60);
  return `${min}:${sec.toString().padStart(2, "0")}/km`;
}

export function buildProsePrompt(
  record: ActivityAnalysisRecord,
  activityName: string,
  streamAnalysis?: StreamAnalysisResult | null
): string {
  const pace = formatPace(record.pace_sec_per_km);
  const gap = record.grade_adjusted_pace_sec_per_km
    ? ` (GAP: ${formatPace(record.grade_adjusted_pace_sec_per_km)})` : "";
  const distKm = (record.distance_m / 1000).toFixed(1);
  const elev = record.elevation_gain_m != null
    ? ` with ${Math.round(record.elevation_gain_m)}m gain` : "";
  const isHilly = record.hill_category && record.hill_category !== "flat";
  // For hilly runs, omit overall avg HR — it blends climb + descent.
  const hrStr = record.avg_heartrate && !isHilly
    ? `, avg HR ${Math.round(record.avg_heartrate)}` : "";

  const hillNote = isHilly
    ? ` Terrain: ${record.hill_category}.` : "";

  const comparisonNote = record.avg_pace_similar_30d != null && record.pace_vs_similar_delta != null
    ? ` Compared to avg ${formatPace(record.avg_pace_similar_30d)} for similar ${record.run_type} runs in past 30d (${record.pace_vs_similar_delta > 0 ? "+" : ""}${record.pace_vs_similar_delta.toFixed(0)}s/km).` : "";

  const validPaces = record.lap_summaries.map(l => l.pace_sec_per_km).filter(p => p > 0);
  const lapInfo = validPaces.length > 1
    ? `\nLaps: ${record.lap_summaries.length} laps, range ${formatPace(Math.min(...validPaces))} to ${formatPace(Math.max(...validPaces))}`
    : "";

  // Stream analysis — only include metrics that could be interesting.
  // Removed: EF (too technical), TRIMP (meaningless without context), NGP (redundant with GAP).
  let analysisBlock = "";
  if (streamAnalysis) {
    const parts: string[] = [];

    if (streamAnalysis.hr_zones) {
      const z = streamAnalysis.hr_zones;
      const total = z.total_hr_s || 1;
      const zoneStrs = [
        z.zone1_s > 0 ? `Z1 ${Math.round(z.zone1_s / total * 100)}%` : null,
        z.zone2_s > 0 ? `Z2 ${Math.round(z.zone2_s / total * 100)}%` : null,
        z.zone3_s > 0 ? `Z3 ${Math.round(z.zone3_s / total * 100)}%` : null,
        z.zone4_s > 0 ? `Z4 ${Math.round(z.zone4_s / total * 100)}%` : null,
        z.zone5_s > 0 ? `Z5 ${Math.round(z.zone5_s / total * 100)}%` : null,
      ].filter(Boolean);
      parts.push(`HR Zones: ${zoneStrs.join(", ")}`);
    }

    if (streamAnalysis.cardiac_drift_pct != null) {
      parts.push(`Cardiac drift: ${streamAnalysis.cardiac_drift_pct.toFixed(1)}%`);
    }

    if (streamAnalysis.split_type === "negative") {
      parts.push(`Split: negative`);
    }

    if (streamAnalysis.fatigue_index_pct != null && Math.abs(streamAnalysis.fatigue_index_pct) > 3) {
      parts.push(`Fatigue: ${streamAnalysis.fatigue_index_pct.toFixed(1)}% pace fade in final quarter`);
    }

    // Hilly runs: climb vs descent breakdown (more useful than overall averages)
    if (isHilly && streamAnalysis.phases.length > 1) {
      const climbs = streamAnalysis.phases.filter(p =>
        (p.elevation_gain_m ?? 0) > (p.elevation_loss_m ?? 0) + 5);
      const descents = streamAnalysis.phases.filter(p =>
        (p.elevation_loss_m ?? 0) > (p.elevation_gain_m ?? 0) + 5);

      const climbSummary = summarizeVerticalPhases(climbs, "gain");
      if (climbSummary) parts.push(`Climbs: ${climbSummary}`);

      const descentSummary = summarizeVerticalPhases(descents, "loss");
      if (descentSummary) parts.push(`Descents: ${descentSummary}`);
    }
    // Non-hilly structured workouts: show phase summary
    else if (streamAnalysis.phases.length > 1 && streamAnalysis.phases.length <= 15) {
      const moving = streamAnalysis.phases.filter(p => p.phase !== "stopped");
      const byType = new Map<string, { count: number; totalDur: number; hrSum: number; hrCount: number }>();
      for (const p of moving) {
        const entry = byType.get(p.phase) ?? { count: 0, totalDur: 0, hrSum: 0, hrCount: 0 };
        entry.count++;
        entry.totalDur += p.end_s - p.start_s;
        if (p.avg_hr != null && p.avg_hr > 0) { entry.hrSum += p.avg_hr; entry.hrCount++; }
        byType.set(p.phase, entry);
      }
      const typeSummaries = Array.from(byType.entries()).map(([type, e]) => {
        const hrPart = e.hrCount > 0 ? `, avg HR ${Math.round(e.hrSum / e.hrCount)}` : "";
        return `${type} ×${e.count} (${formatDuration(e.totalDur)}${hrPart})`;
      });
      parts.push(`Phases: ${typeSummaries.join(", ")}`);
    }

    if (streamAnalysis.intervals.length >= 2) {
      parts.push(`Intervals: ${streamAnalysis.intervals.length} reps detected`);
    }

    if (parts.length > 0) {
      analysisBlock = `\n\nAnalysis:\n${parts.join("\n")}`;
    }
  }

  const isEasyRun = ["easy", "recovery", "long_run"].includes(record.run_type);
  const lengthGuide = isEasyRun ? "1-2 sentences" : "2-3 sentences";

  return `Write a brief coaching summary for this run (${lengthGuide}). Describe what the run was, then mention only what's genuinely noteworthy. Most metrics are expected — skip them. If a coach would glance at a number, shrug, and not mention it to the athlete, leave it out. Never list metrics — weave observations into natural prose. Use impersonal voice (not "you"). Do not use bullet points, headers, or emoji. Use regular hyphens (-), never em dashes (—). Only reference data provided below.

<examples>
<example>
<run>Easy, 8.5km, 5:40/km, avg HR 136. HR Zones: Z1 40%, Z2 58%, Z3 2%. Cardiac drift: 2.8%.</run>
<summary>Easy midweek mileage with HR comfortably in Z1-Z2 throughout. Nothing to note - exactly what a recovery day should look like.</summary>
</example>
<example>
<run>Tempo, 12km, 4:45/km. Laps: 2km warmup, 8km at 4:15-4:22, 2km cooldown. HR Zones: Z3 35%, Z4 55%. Cardiac drift: 6.2%. Fatigue: 7.1%.</run>
<summary>8km of threshold work at 4:18/km after a warm-up. Pacing was disciplined through 6km but the last two K drifted to 4:22 with HR climbing - the 7% fade suggests the effort was right at the limit. Good session to build from.</summary>
</example>
<example>
<run>Hill run, 18km, 8:30/km (GAP: 5:50/km), 1200m gain. Climbs: 80min, avg HR 165, ~12:00/km. Descents: 65min, avg HR 140, ~5:30/km. Cardiac drift: 4.8%.</run>
<summary>18km in the hills with 1200m of climbing. The climbs pushed HR to 165 at hiking pace while descents provided active recovery at 140. Good cardiac drift control over 2.5 hours of sustained vertical work.</summary>
</example>
</examples>

<bad_example>
<output>Solid easy run covering 8.2km at 5:32/km. Heart rate averaged 138 bpm, 45% Z1, 55% Z2. Cardiac drift 3.2% showing good coupling. Even splits throughout.</output>
<why_bad>Lists every metric — a data readback, not a coaching insight.</why_bad>
</bad_example>

Run: "${activityName}"
Type: ${record.run_type}${record.run_type_detail ? ` (${record.run_type_detail})` : ""}
Distance: ${distKm}km${elev}
Pace: ${pace}${gap}${hrStr}${hillNote}${comparisonNote}${lapInfo}${analysisBlock}`;
}

/**
 * Generate a prose summary for an activity using the Anthropic API,
 * then save it to the analysis record in the database.
 * Returns the generated prose text, or null if generation failed.
 */
export async function generateProseSummary(
  record: ActivityAnalysisRecord,
  activityName: string,
  streamAnalysis: StreamAnalysisResult | null,
  db: Database,
  client?: Anthropic
): Promise<string | null> {
  const anthropic = client ?? new Anthropic();
  const prompt = buildProsePrompt(record, activityName, streamAnalysis);
  const message = await anthropic.messages.create({
    model: "claude-opus-4-6",
    max_tokens: 16000,
    temperature: 1,
    thinking: { type: "enabled", budget_tokens: 10000 },
    messages: [{ role: "user", content: prompt }],
  });

  const prose = message.content.find(b => b.type === "text")?.text ?? null;
  if (prose) {
    record.prose_summary = prose;
    record.prose_generated_at = new Date().toISOString();
    saveActivityAnalysis(record, db);
  }
  return prose;
}

function summarizeVerticalPhases(
  phases: { start_s: number; end_s: number; elevation_gain_m: number | null; elevation_loss_m: number | null; avg_hr: number | null; avg_pace_sec_per_km: number | null }[],
  direction: "gain" | "loss"
): string | null {
  if (phases.length === 0) return null;

  const totalTime = phases.reduce((s, p) => s + (p.end_s - p.start_s), 0);
  const totalElev = phases.reduce((s, p) => {
    return s + (direction === "gain" ? (p.elevation_gain_m ?? 0) : (p.elevation_loss_m ?? 0));
  }, 0);

  const hrs = phases.filter(p => p.avg_hr).map(p => p.avg_hr!);
  const avgHr = hrs.length > 0 ? Math.round(hrs.reduce((a, b) => a + b, 0) / hrs.length) : null;

  const paces = phases
    .filter(p => p.avg_pace_sec_per_km && p.avg_pace_sec_per_km < 2000)
    .map(p => p.avg_pace_sec_per_km!);
  const avgPace = paces.length > 0
    ? formatPace(paces.reduce((a, b) => a + b, 0) / paces.length) : null;

  const sign = direction === "gain" ? "+" : "-";
  return `${formatDuration(totalTime)}, ${sign}${Math.round(totalElev)}m${avgHr ? `, avg HR ${avgHr}` : ""}${avgPace ? `, ~${avgPace}` : ""}`;
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  if (m === 0) return `${s}s`;
  return s > 0 ? `${m}m${s}s` : `${m}m`;
}
