import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { getDb, getStreamAnalysis, getActivityWeather } from "../utils/activities-db.js";
import {
  getActivityAnalysis,
  computeActivityAnalysis,
  saveActivityAnalysis,
  computeTrainingContext,
} from "../utils/activity-analysis.js";
import { toolResult, toolError, formatPace } from "../utils/format.js";
import { loadHrZones, computeEasyPaceRef } from "../utils/hr-zones.js";
import { STREAM_ANALYSIS_VERSION } from "../utils/stream-analysis.js";
import type { LapSummary, StreamAnalysisResult } from "../types/index.js";

interface Confounds {
  stopped_time_pct: number;
  lap_pace_cv: number;
  run_shape_anomaly: boolean;
  warnings: string[];
}

function computeConfounds(
  activityId: number,
  lapSummaries: LapSummary[],
): Confounds {
  const db = getDb();
  const row = db.prepare(
    "SELECT moving_time, elapsed_time FROM activities WHERE id = ?",
  ).get(activityId) as { moving_time: number | null; elapsed_time: number | null } | undefined;

  const elapsed = row?.elapsed_time ?? 0;
  const moving = row?.moving_time ?? elapsed;
  const stoppedPct = elapsed > 0 ? (elapsed - moving) / elapsed : 0;

  const paces = lapSummaries.map(l => l.pace_sec_per_km).filter(p => p > 0);
  let cv = 0;
  let anomaly = false;
  if (paces.length >= 2) {
    const mean = paces.reduce((a, b) => a + b, 0) / paces.length;
    const variance = paces.reduce((a, b) => a + (b - mean) ** 2, 0) / paces.length;
    cv = mean > 0 ? Math.sqrt(variance) / mean : 0;

    const sorted = [...paces].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 === 1
      ? sorted[mid]
      : (sorted[mid - 1] + sorted[mid]) / 2;
    anomaly = paces.some(p => p > 1.5 * median || p < median / 1.5);
  }

  const warnings: string[] = [];
  if (stoppedPct > 0.05) {
    warnings.push(
      `stopped_time ${(stoppedPct * 100).toFixed(0)}% of elapsed — lap-averaged metrics (avg pace, zone%, cardiac drift) may be confounded by stops/traffic/walks. Per-second stream phases are more reliable than lap summaries here.`,
    );
  }
  if (anomaly) {
    warnings.push(
      "at least one lap is a major pace outlier (>50% from run median) — investigate that segment before assuming a smooth structure (warmup vs traffic vs hill vs walk are indistinguishable in lap data).",
    );
  }
  // Only emit the CV warning when the anomaly check didn't already flag the same structural issue.
  if (cv > 0.20 && !anomaly) {
    warnings.push(
      `lap pace coefficient of variation ${(cv * 100).toFixed(0)}% (>20%) — pacing is highly variable. Could be deliberate intervals, terrain, group dynamics, or stop-start; data alone doesn't disambiguate.`,
    );
  }

  return {
    stopped_time_pct: parseFloat(stoppedPct.toFixed(3)),
    lap_pace_cv: parseFloat(cv.toFixed(3)),
    run_shape_anomaly: anomaly,
    warnings,
  };
}

export const getRunAnalysisTool = tool(
  "get_run_analysis",
  "Get pre-computed deterministic analysis for a specific run. Returns classification, metrics, stream analysis (HR zones, cardiac drift, phases, intervals), and lap summaries. If not yet analyzed, computes analysis on demand. Use this to get structured data for writing Strava descriptions or answering questions about a run.",
  {
    activity_id: z.number().describe("Strava activity ID"),
  },
  async ({ activity_id }) => {
    try {
      let record = getActivityAnalysis(activity_id);
      let sa: StreamAnalysisResult | null = getStreamAnalysis(activity_id);

      // Recompute if missing OR if cached stream analysis is from an older
      // version (so peak HR fields and other version-bumped derivatives appear
      // without manual migration).
      const streamStale = sa != null && sa.stream_analysis_version < STREAM_ANALYSIS_VERSION;
      if (!record || streamStale) {
        const zones = await loadHrZones();
        const hrZones = zones.confirmed ? zones : null;
        const easyPaceRef = computeEasyPaceRef();
        const result = computeActivityAnalysis(activity_id, hrZones, easyPaceRef);
        if (!result) {
          return toolResult(`No data found for activity ${activity_id}. Run strava_sync first.`, true);
        }
        saveActivityAnalysis(result.analysis);
        record = result.analysis;
        if (result.streamAnalysis) sa = result.streamAnalysis;
      }

      const trainingContext = computeTrainingContext(activity_id);
      const activityWeather = getActivityWeather(activity_id);

      // Build stream metrics for output
      const streamMetrics = sa ? {
        hr_zones: sa.hr_zones,
        cardiac_drift_pct: sa.cardiac_drift_pct,
        pace_variability_cv: sa.pace_variability_cv,
        split_type: sa.split_type,
        trimp: sa.trimp != null ? Math.round(sa.trimp) : null,
        ngp: sa.ngp_sec_per_km ? formatPace(sa.ngp_sec_per_km) : null,
        fatigue_index_pct: sa.fatigue_index_pct,
        cadence_drift_spm: sa.cadence_drift_spm,
        efficiency_factor: sa.efficiency_factor,
        phase_count: sa.phases.length,
        phases: sa.phases.map(p => ({
          phase: p.phase,
          duration_s: Math.round(p.end_s - p.start_s),
          distance_m: p.distance_m,
          avg_pace: p.avg_pace_sec_per_km ? formatPace(p.avg_pace_sec_per_km) : null,
          avg_hr: p.avg_hr,
          peak_hr: p.peak_hr,
          elevation_gain_m: p.elevation_gain_m,
          elevation_loss_m: p.elevation_loss_m,
          ...(p.hr_trend ? { hr_trend: p.hr_trend } : {}),
        })),
        interval_count: sa.intervals.length,
        intervals: sa.intervals.length > 0 ? sa.intervals.map(i => {
          const durationS = i.work_end_s - i.work_start_s;
          const isShort = durationS < 90;
          return {
            rep: i.rep_number,
            duration_s: Math.round(durationS),
            distance_m: i.work_distance_m,
            pace: i.work_avg_pace_sec_per_km > 0 ? formatPace(i.work_avg_pace_sec_per_km) : null,
            avg_hr: i.work_avg_hr,
            peak_hr: i.work_peak_hr,
            peak_hr_lagged: i.work_peak_hr_lagged,
            // For reps shorter than ~90s, avg_hr understates effort due to
            // cardiac lag (HR is still rising through most of the rep, often
            // peaking 5–15s into recovery). Use peak_hr_lagged as the effort
            // indicator on short reps.
            ...(isShort ? { hr_note: "rep < 90s: avg_hr understates effort due to cardiac lag — use peak_hr_lagged for effort assessment" } : {}),
          };
        }) : undefined,
      } : null;

      const output = {
        activity_id: record.activity_id,
        run_type: record.run_type,
        run_type_detail: record.run_type_detail,
        hill_category: record.hill_category,
        moving_time_min: Math.round(record.moving_time_s / 60),
        distance_km: (record.distance_m / 1000).toFixed(1),
        pace: formatPace(record.pace_sec_per_km),
        grade_adjusted_pace: record.grade_adjusted_pace_sec_per_km
          ? formatPace(record.grade_adjusted_pace_sec_per_km) : null,
        elevation: record.elevation_gain_m != null ? {
          gain_m: Math.round(record.elevation_gain_m),
          loss_m: record.elevation_loss_m != null ? Math.round(record.elevation_loss_m) : null,
        } : null,
        avg_heartrate: record.avg_heartrate ? Math.round(record.avg_heartrate) : null,
        lap_count: record.lap_summaries.length,
        lap_summaries: record.lap_summaries,
        comparison: record.avg_pace_similar_30d != null ? {
          avg_pace_similar_30d: formatPace(record.avg_pace_similar_30d),
          delta_sec_per_km: record.pace_vs_similar_delta,
          similar_runs_30d: record.similar_runs_30d,
        } : null,
        training_context: trainingContext,
        weather: activityWeather ? {
          temp_c: activityWeather.temp_c,
          feels_like_c: activityWeather.feels_like_c,
          humidity_pct: activityWeather.humidity_pct,
          wind_speed_kmh: activityWeather.wind_speed_kmh,
          wind_gust_kmh: activityWeather.wind_gust_kmh,
          precipitation_mm: activityWeather.precipitation_mm,
          description: activityWeather.weather_description,
        } : null,
        stream_analysis: streamMetrics,
        confounds: computeConfounds(activity_id, record.lap_summaries),
        detailed_analysis: record.detailed_analysis,
        strava_title: record.strava_title,
        strava_description: record.strava_description,
        analyzed_at: record.analyzed_at,
      };

      return toolResult(JSON.stringify(output, null, 2));
    } catch (error) {
      return toolError(error);
    }
  }
);
