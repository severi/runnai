import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { initDatabase, getStreamAnalysis } from "../utils/activities-db.js";
import {
  getActivityAnalysis,
  computeActivityAnalysis,
  saveActivityAnalysis,
  formatPace,
  computeTrainingContext,
} from "../utils/activity-analysis.js";
import { loadHrZones, computeEasyPaceRef } from "../utils/hr-zones.js";
import type { StreamAnalysisResult } from "../types/index.js";

export const getRunAnalysisTool = tool(
  "get_run_analysis",
  "Get pre-computed deterministic analysis for a specific run. Returns classification, metrics, stream analysis (HR zones, cardiac drift, phases, intervals), and lap summaries. If not yet analyzed, computes analysis on demand. Use this to get structured data for writing Strava descriptions or answering questions about a run.",
  {
    activity_id: z.number().describe("Strava activity ID"),
  },
  async ({ activity_id }) => {
    try {
      const db = initDatabase();
      try {
        let record = getActivityAnalysis(activity_id, db);
        let sa: StreamAnalysisResult | null = getStreamAnalysis(activity_id, db);

        // Compute if missing (lazy analysis for older runs)
        if (!record) {
          const zones = await loadHrZones();
          const hrZones = zones.confirmed ? zones : null;
          const easyPaceRef = computeEasyPaceRef();
          const result = computeActivityAnalysis(activity_id, db, hrZones, easyPaceRef);
          if (!result) {
            return {
              content: [{ type: "text" as const, text: `No data found for activity ${activity_id}. Run strava_sync first.` }],
              isError: true,
            };
          }
          saveActivityAnalysis(result.analysis, db);
          record = result.analysis;
          if (result.streamAnalysis) sa = result.streamAnalysis;
        }

        const trainingContext = computeTrainingContext(activity_id, db);

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
            elevation_gain_m: p.elevation_gain_m,
            elevation_loss_m: p.elevation_loss_m,
          })),
          interval_count: sa.intervals.length,
          intervals: sa.intervals.length > 0 ? sa.intervals.map(i => ({
            rep: i.rep_number,
            distance_m: i.work_distance_m,
            pace: i.work_avg_pace_sec_per_km > 0 ? formatPace(i.work_avg_pace_sec_per_km) : null,
            avg_hr: i.work_avg_hr,
          })) : undefined,
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
          stream_analysis: streamMetrics,
          detailed_analysis: record.detailed_analysis,
          strava_title: record.strava_title,
          strava_description: record.strava_description,
          analyzed_at: record.analyzed_at,
        };

        return { content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }] };
      } finally {
        db.close();
      }
    } catch (error) {
      return {
        content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  }
);
