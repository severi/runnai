import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { getDb, getStreamAnalysis, getActivityWeather } from "../utils/activities-db.js";
import {
  getActivityAnalysis,
  computeActivityAnalysis,
  saveActivityAnalysis,
  computeTrainingContext,
} from "../utils/activity-analysis.js";
import type { ActivityWeather } from "../utils/activities-db.js";
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

function bandsToMinutes(bands: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(bands)) out[k] = Math.round(v / 60);
  return out;
}

/**
 * Elevation with a source-of-truth policy. The device stream (barometric when
 * the watch has a sensor, consistent smoothing + hysteresis) is primary;
 * Strava's reported activity total is shown alongside. When the two disagree
 * by more than 20%, the discrepancy is surfaced so the analysis names it
 * instead of silently picking a number — WITHOUT asserting a mechanism for
 * Strava's figure (it varies: DEM-corrected for non-baro devices, otherwise
 * server-side processing of the device data).
 */
function buildElevationOutput(
  apiGainM: number | null,
  apiLossM: number | null,
  sa: StreamAnalysisResult | null,
): Record<string, unknown> | null {
  const stream = sa?.elevation_stream ?? null;
  if (stream == null && apiGainM == null) return null;

  const gain = stream ? stream.gain_m : Math.round(apiGainM!);
  const out: Record<string, unknown> = {
    gain_m: gain,
    loss_m: stream ? stream.loss_m : apiLossM != null ? Math.round(apiLossM) : null,
    source: stream ? "device-stream" : "strava-api",
  };
  if (stream && apiGainM != null) {
    out.strava_gain_m = Math.round(apiGainM);
    const base = Math.max(stream.gain_m, apiGainM);
    if (base > 0) {
      const discrepancyPct = Math.round((Math.abs(stream.gain_m - apiGainM) / base) * 100);
      if (discrepancyPct > 20) {
        out.discrepancy_note = `device-stream gain (${stream.gain_m}m) and Strava's reported total (${Math.round(apiGainM)}m) differ by ${discrepancyPct}%. The stream value uses a consistent smoothing+hysteresis algorithm on the recorded altitude; Strava's figure comes from its own server-side processing, whose method varies by upload/device — do not assert a specific mechanism (DEM, barometer, noise) for the gap. Use the device-stream value for the terrain read and name the discrepancy rather than silently picking one.`;
      }
    }
  }
  return out;
}

/**
 * Weather for the model. The window average is deliberately named temp_avg_c —
 * on a multi-hour activity it blends morning cool with afternoon peak into a
 * number that describes no moment of the run, so min/max and the hourly
 * profile are surfaced alongside and an explicit note forbids quoting the
 * average as "the temperature".
 */
function buildWeatherOutput(w: ActivityWeather): Record<string, unknown> {
  const out: Record<string, unknown> = {
    temp_avg_c: w.temp_c,
    temp_min_c: w.temp_min_c,
    temp_max_c: w.temp_max_c,
    feels_like_avg_c: w.feels_like_c,
    humidity_pct: w.humidity_pct,
    wind_speed_kmh: w.wind_speed_kmh,
    wind_gust_kmh: w.wind_gust_kmh,
    precipitation_mm: w.precipitation_mm,
    description: w.weather_description,
  };
  if (w.hourly && w.hourly.length > 0) {
    out.hourly = w.hourly;
    if (w.hourly.length > 3) {
      out.note = `conditions evolved across this ${w.hourly.length}-hour window (${w.temp_min_c}°C to ${w.temp_max_c}°C) — temp_avg_c is a window average that describes no single moment. Narrate heat from the hourly profile (when the peak hit relative to the athlete's position), never quote the average as "the temperature". Temps are shaded-air at the start coordinates; full sun feels several degrees hotter.`;
    }
  }
  return out;
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
        // Run/walk/pause decomposition. On run-walk sessions (trail/ultra, or
        // any run with deliberate walk breaks), the raw split_type/fatigue above
        // are walk-contaminated — read `movement.split_driver` FIRST. "walking"
        // means moving pace fell but run-only pace held: report it as "running
        // held steady, walking increased", NOT a running fade. Walk segments are
        // already localized and banded by signed grade; never infer walk locations.
        movement: sa.movement ? {
          run_min: Math.round(sa.movement.run_s / 60),
          walk_min: Math.round(sa.movement.walk_s / 60),
          pause_min: Math.round(sa.movement.pause_s / 60),
          walk_pct_of_moving: sa.movement.walk_pct,
          walk_share_by_half_pct: sa.movement.walk_share_by_half,
          // On a run-walk session the top-level avg_heartrate blends two
          // different states and understates the running effort — run_avg_hr
          // is the number that describes the actual running load. Never infer
          // "low avg HR → engine wasn't the limiter" when walk_pct is material.
          run_avg_hr: sa.movement.run_avg_hr,
          walk_avg_hr: sa.movement.walk_avg_hr,
          run_avg_hr_by_half: sa.movement.run_avg_hr_by_half,
          // Walk time per signed grade band (descent < -1% | flat ±1% |
          // gentle_up 1-3% | moderate_up 3-6% | steep_up > 6%), whole run and
          // by half. This answers "was the walking terrain-driven?" directly —
          // and walking spreading to flats/descents in the second half is a
          // fuel/fatigue fingerprint, not a terrain story.
          walk_grade_band_min: sa.movement.walk_grade_band_s
            ? bandsToMinutes(sa.movement.walk_grade_band_s) : null,
          walk_grade_band_min_by_half: sa.movement.walk_grade_band_s_by_half
            ? sa.movement.walk_grade_band_s_by_half.map(bandsToMinutes) : null,
          split_driver: sa.movement.split_driver,
          run_only_split_type: sa.movement.run_only_split_type,
          run_only_fatigue_index_pct: sa.movement.run_only_fatigue_index_pct,
          walks: sa.movement.walks.map(w => ({
            at_km: w.start_km,
            duration_s: w.duration_s,
            avg_grade_pct: w.avg_grade_pct,
            grade_band: w.grade_band,
          })),
          pauses: sa.movement.pauses.map(p => ({
            at_km: p.start_km,
            duration_s: p.duration_s,
          })),
        } : null,
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
        elevation: buildElevationOutput(record.elevation_gain_m, record.elevation_loss_m, sa),
        avg_heartrate: record.avg_heartrate ? Math.round(record.avg_heartrate) : null,
        lap_count: record.lap_summaries.length,
        lap_summaries: record.lap_summaries,
        comparison: record.avg_pace_similar_30d != null ? {
          avg_pace_similar_30d: formatPace(record.avg_pace_similar_30d),
          delta_sec_per_km: record.pace_vs_similar_delta,
          similar_runs_30d: record.similar_runs_30d,
        } : null,
        training_context: trainingContext,
        // Never emit bare null for weather: a missing record must read as
        // "go fetch it", not "there was no weather" — a race analysis without
        // conditions data was drafted exactly that way once.
        weather: activityWeather ? buildWeatherOutput(activityWeather) : {
          missing: true,
          note: "No stored weather for this run. Before drafting any read that touches conditions (heat, wind, rain — mandatory for races and multi-hour runs), fetch it: get_weather(activity_id, start_date=run date, granularity='hourly' for multi-hour activities).",
        },
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
