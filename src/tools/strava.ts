import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import {
  startAutomaticAuth,
  hasClientCredentials,
  getAuthUrl,
  syncActivities,
  getAthleteProfile,
  fetchActivityDetail,
  fetchActivityStream,
  convertStravaBestEfforts,
  updateActivity,
  loadTokens,
} from "../strava/client.js";
import type { StravaActivity, ActivityLapRecord, ActivityStream } from "../types/index.js";
import {
  queryActivities,
  getLatestActivityDate,
  getExistingActivityIds,
  upsertStravaBestEfforts,
  markActivityDetailFetched,
  getActivitiesWithoutDetail,
  upsertActivityLaps,
  getActivityLaps,
  setRunType,
  getUnclassifiedActivities,
  saveActivityStreams,
  computeLapElevation,
} from "../utils/activities-db.js";
import {
  computeActivityAnalysis,
  saveActivityAnalysis,
  getRecentUnanalyzedActivityIds,
} from "../utils/activity-analysis.js";
import { fetchActivityWeather } from "../utils/activity-weather.js";
import { saveActivityWeather, getActivitiesWithoutWeather } from "../utils/activities-db.js";
import { loadHrZones, computeEasyPaceRef } from "../utils/hr-zones.js";
import { classifyRun, detectHillProfile } from "../utils/run-classifier.js";
import { generateTrainingPatterns } from "../utils/training-patterns.js";
import { toDateString, toolResult, toolError, formatPace } from "../utils/format.js";

/**
 * Fetch and store activity detail (best efforts, streams, laps) from Strava.
 * Returns the fetched streams (if any) for downstream analysis.
 */
async function fetchAndStoreActivityDetail(
  activityId: number
): Promise<ActivityStream | undefined> {
  const detail = await fetchActivityDetail(activityId);
  if (detail.bestEfforts.length > 0) {
    const records = convertStravaBestEfforts(activityId, detail.bestEfforts);
    upsertStravaBestEfforts(records);
  }
  let altitude: number[] | undefined;
  let streams: ActivityStream | undefined;
  try {
    const fetched = await fetchActivityStream(activityId);
    if (fetched) {
      saveActivityStreams(activityId, fetched);
      altitude = fetched.altitude;
      streams = fetched;
    }
  } catch {
    // Stream fetch is best-effort, don't fail sync
  }
  if (detail.laps.length > 0) {
    const lapRecords: ActivityLapRecord[] = detail.laps.map(lap => {
      const elev = altitude ? computeLapElevation(altitude, lap.start_index, lap.end_index) : null;
      return {
        activity_id: activityId,
        lap_index: lap.lap_index,
        distance: lap.distance,
        elapsed_time: lap.elapsed_time,
        moving_time: lap.moving_time,
        average_speed: lap.average_speed,
        max_speed: lap.max_speed,
        average_heartrate: lap.average_heartrate ?? null,
        max_heartrate: lap.max_heartrate ?? null,
        start_index: lap.start_index,
        end_index: lap.end_index,
        elevation_gain: elev?.gain ?? null,
        elevation_loss: elev?.loss ?? null,
      };
    });
    upsertActivityLaps(activityId, lapRecords);
  }
  markActivityDetailFetched(activityId);
  return streams;
}

export const stravaSyncTool = tool(
  "strava_sync",
  "Syncs activities from Strava to local SQLite database. Incremental by default: fetches only activities newer than the last known activity.",
  {
    days: z.number().optional().describe("Number of days to fetch for full (non-incremental) sync. Default 30."),
    incremental: z.boolean().optional().describe("If true (default), only fetch activities since last sync."),
    backfill_best_efforts: z.number().optional().describe("Fetch detail for N historical activities that haven't been fetched yet. Recommended 20-50 per session."),
  },
  async ({ days = 30, incremental = true, backfill_best_efforts }) => {
    try {
      const existingIds = incremental ? getExistingActivityIds() : new Set<number>();
      const isIncremental = incremental && existingIds.size > 0;

      const syncResult = await syncActivities(days, undefined, incremental);
      if (!syncResult.success) {
        if (syncResult.needsAuth) {
          return toolError(syncResult.error || "Strava not authorized");
        }
        return toolError(syncResult.error || "Sync failed");
      }

      const activities = syncResult.allActivities ?? [];
      const newActivities = activities.filter((a) => !existingIds.has(a.id));
      const newRuns = newActivities.filter((a) => (a.type === "Run" || a.sport_type === "Run") && !a.trainer);
      const newNonRuns = newActivities.filter((a) => !((a.type === "Run" || a.sport_type === "Run") && !a.trainer));
      const allRuns = activities.filter((a) => a.type === "Run" || a.sport_type === "Run");

      // Fetch best efforts + laps + streams from Strava detail API for new runs
      let detailFetched = 0;
      const cachedStreams = new Map<number, ActivityStream>();
      for (const run of newRuns) {
        try {
          const streams = await fetchAndStoreActivityDetail(run.id);
          if (streams) cachedStreams.set(run.id, streams);
          detailFetched++;
          await new Promise((resolve) => setTimeout(resolve, 50));
        } catch (error) {
          if (error instanceof Error && error.message === "RATE_LIMITED") break;
        }
      }

      // Auto-backfill historical activities (always runs, bounded to stay within rate limits)
      let backfillCount = 0;
      const backfillLimit = backfill_best_efforts ?? 100;
      {
        const toBackfill = getActivitiesWithoutDetail(backfillLimit);
        for (const activity of toBackfill) {
          try {
            await fetchAndStoreActivityDetail(activity.id);
            backfillCount++;
            await new Promise((resolve) => setTimeout(resolve, 100));
          } catch (error) {
            if (error instanceof Error && error.message === "RATE_LIMITED") break;
          }
        }
      }

      // Analyze runs: classify (with hill detection) + compute structured analysis + generate prose
      const classificationMap = new Map<number, { run_type: string; run_type_detail: string | null }>();
      let analyzedCount = 0;
      let zonesNeedConfirmation = false;
      let estimatedZones: { lt1: number; lt2: number; max_hr: number } | null = null;
      try {
        const zones = await loadHrZones();

        if (!zones.confirmed) {
          zonesNeedConfirmation = true;
          estimatedZones = { lt1: zones.lt1, lt2: zones.lt2, max_hr: zones.max_hr };
        } else {
          const easyPaceRef = computeEasyPaceRef();
          const hrZones = zones;

          // Analyze newly fetched runs (pass cached streams for stream analysis)
          for (const run of newRuns) {
            const result = computeActivityAnalysis(run.id, hrZones, easyPaceRef, cachedStreams.get(run.id));
            if (result) {
              saveActivityAnalysis(result.analysis);
              setRunType(run.id, result.analysis.run_type, result.analysis.run_type_detail);
              classificationMap.set(run.id, { run_type: result.analysis.run_type, run_type_detail: result.analysis.run_type_detail });
              analyzedCount++;
            }
          }

          // Backfill: analyze runs with detail but no analysis yet (last 7 days + unclassified)
          const toAnalyze = getRecentUnanalyzedActivityIds(7);
          for (const actId of toAnalyze) {
            const result = computeActivityAnalysis(actId, hrZones, easyPaceRef);
            if (result) {
              saveActivityAnalysis(result.analysis);
              setRunType(actId, result.analysis.run_type, result.analysis.run_type_detail);
              analyzedCount++;
            }
          }

          // Also classify any remaining unclassified runs (older than 7 days, no analysis needed)
          const unclassified = getUnclassifiedActivities(50);
          for (const a of unclassified) {
            const laps = getActivityLaps(a.id);
            const hillProfile = detectHillProfile(laps, a.distance);
            const result = classifyRun(
              { id: a.id, distance: a.distance, moving_time: a.moving_time, average_speed: a.average_speed, average_heartrate: a.average_heartrate, workout_type: a.workout_type },
              laps, hrZones, easyPaceRef, hillProfile
            );
            setRunType(a.id, result.run_type, result.run_type_detail);
          }

          // Regenerate training patterns
          await generateTrainingPatterns();
        }
      } catch {
        // Analysis is best-effort, don't fail the sync
      }

      // Fetch weather for new runs + backfill runs without weather
      let weatherFetched = 0;
      try {
        const runsNeedingWeather = [
          ...newRuns
            .filter(r => r.start_latlng?.[0] != null)
            .map(r => ({
              id: r.id,
              start_date_local: r.start_date_local,
              start_latitude: r.start_latlng![0],
              start_longitude: r.start_latlng![1],
              moving_time: r.moving_time,
            })),
          ...getActivitiesWithoutWeather(20),
        ];
        // Deduplicate by activity ID
        const seen = new Set<number>();
        for (const run of runsNeedingWeather) {
          if (seen.has(run.id)) continue;
          seen.add(run.id);
          const weather = await fetchActivityWeather(
            run.id, run.start_latitude, run.start_longitude,
            run.start_date_local, run.moving_time
          );
          if (weather) {
            saveActivityWeather(weather);
            weatherFetched++;
          }
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      } catch {
        // Weather fetch is best-effort
      }

      // --- Build output text (after classification so we can include run types) ---
      let text: string;
      if (isIncremental) {
        if (newActivities.length === 0) {
          text = `INCREMENTAL SYNC — Already up to date. No new activities since last sync.`;
        } else {
          const newRunDistance = Math.round(newRuns.reduce((sum, r) => sum + r.distance, 0) / 100) / 10;
          text = `INCREMENTAL SYNC — ${newActivities.length} new activit${newActivities.length === 1 ? "y" : "ies"} found (${newRuns.length} run${newRuns.length !== 1 ? "s" : ""}, ${newRunDistance}km${newNonRuns.length > 0 ? `, ${newNonRuns.length} other` : ""}).`;
          if (newRuns.length > 0) {
            text += `\n\nNew runs since last sync:`;
            for (const run of newRuns) {
              const date = toDateString(new Date(run.start_date_local));
              const distKm = Math.round(run.distance / 100) / 10;
              const paceSecPerKm = run.distance > 0 ? (run.moving_time / run.distance) * 1000 : 0;
              const cls = classificationMap.get(run.id);
              const tag = cls ? (cls.run_type_detail ? ` [${cls.run_type}: ${cls.run_type_detail}]` : ` [${cls.run_type}]`) : "";
              text += `\n- ${date}: "${run.name}" (id: ${run.id}) — ${distKm}km @ ${formatPace(paceSecPerKm)}${tag}`;
            }
          }
          if (newNonRuns.length > 0) {
            text += `\n\nOther new activities:`;
            for (const act of newNonRuns) {
              const date = toDateString(new Date(act.start_date_local));
              const distKm = act.distance > 0 ? `${Math.round(act.distance / 100) / 10}km` : "";
              const durationMin = Math.round(act.moving_time / 60);
              const type = act.sport_type || act.type;
              text += `\n- ${date}: "${act.name}" (${type}${distKm ? `, ${distKm}` : ""}, ${durationMin}min)`;
            }
          }
        }
      } else {
        const nonRuns = activities.filter((a) => !((a.type === "Run" || a.sport_type === "Run") && !a.trainer));
        text = `FULL SYNC — ${activities.length} activities (${allRuns.length} runs, ${nonRuns.length} other) from the last ${days} days.`;
      }

      const mostRecentRun = allRuns.sort(
        (a, b) => new Date(b.start_date_local).getTime() - new Date(a.start_date_local).getTime()
      )[0];
      if (mostRecentRun) {
        const date = toDateString(new Date(mostRecentRun.start_date_local));
        const distKm = Math.round(mostRecentRun.distance / 100) / 10;
        const paceSecPerKm = mostRecentRun.distance > 0 ? (mostRecentRun.moving_time / mostRecentRun.distance) * 1000 : 0;
        text += `\n\nMost recent run: ${date} "${mostRecentRun.name}" - ${distKm}km @ ${formatPace(paceSecPerKm)}`;
      }

      if (detailFetched > 0) {
        text += `\nBest efforts fetched for ${detailFetched} new run${detailFetched > 1 ? "s" : ""}.`;
      }
      if (backfillCount > 0) {
        const remaining = getActivitiesWithoutDetail(1).length;
        text += `\nBackfilled best efforts for ${backfillCount} historical run${backfillCount > 1 ? "s" : ""}${remaining > 0 ? ` (${remaining} remaining)` : " (all done)"}.`;
      }
      if (analyzedCount > 0) {
        text += `\nAnalyzed ${analyzedCount} run${analyzedCount > 1 ? "s" : ""}.`;
      }
      if (weatherFetched > 0) {
        text += `\nWeather fetched for ${weatherFetched} run${weatherFetched > 1 ? "s" : ""}.`;
      }

      if (zonesNeedConfirmation) {
        text += `\n\n⚠️ HR ZONES NOT CONFIRMED — run classification deferred.`;
        text += `\nLaps stored but runs not classified yet.`;
        if (estimatedZones) {
          text += `\n\nEstimated from Strava data: LT1 ~${estimatedZones.lt1} bpm, LT2 ~${estimatedZones.lt2} bpm, Max HR ~${estimatedZones.max_hr} bpm.`;
        }
        text += `\n\nAsk the athlete to confirm HR zones before classifying. Key questions:`;
        text += `\n1. Have you done a lactate test or threshold test? If so, what were the results?`;
        text += `\n2. What's the highest heart rate you've seen during a race or all-out effort?`;
        text += `\n3. Do you use HR zones on your watch? What are the thresholds set to?`;
        text += `\nIf they don't know exact values, present the estimated defaults above for confirmation.`;
        text += `\nUse set_hr_zones to save, then sync again to classify all runs.`;
      }

      text += `\n\nRecent summary updated. Today: ${toDateString()}`;

      return toolResult(text);
    } catch (error) {
      return toolError(error);
    }
  }
);

export const stravaProfileTool = tool(
  "strava_profile",
  "Fetches athlete's Strava profile and syncs their running history to SQLite.",
  {
    days: z.number().optional().describe("Number of days of activities to sync (default: 180)"),
  },
  async ({ days = 180 }) => {
    try {
      const profileResult = await getAthleteProfile();
      if (!profileResult.success || !profileResult.athlete) {
        return toolResult(profileResult.error || "Failed to fetch profile", true);
      }
      const athlete = profileResult.athlete;

      // Incremental sync if we already have data, full sync otherwise
      const latestDate = getLatestActivityDate();
      const syncResult = latestDate
        ? await syncActivities(days, latestDate)
        : await syncActivities(days);

      // Backfill activity detail (best efforts, laps) for runs that don't have it yet
      let backfillCount = 0;
      const toBackfill = getActivitiesWithoutDetail(100);
      for (const activity of toBackfill) {
        try {
          await fetchAndStoreActivityDetail(activity.id);
          backfillCount++;
          await new Promise((resolve) => setTimeout(resolve, 50));
        } catch (error) {
          if (error instanceof Error && error.message === "RATE_LIMITED") break;
        }
      }

      let text = `**Strava Data Synced**\n\n`;
      text += `**Athlete**: ${athlete.firstname} ${athlete.lastname}\n`;

      const locationParts = [athlete.city, athlete.state, athlete.country].filter(Boolean);
      if (locationParts.length > 0) {
        text += `**Location**: ${locationParts.join(", ")}\n`;
      }

      if (syncResult.success && syncResult.activities) {
        const totalKm = Math.round(syncResult.activities.reduce((sum, r) => sum + r.distance, 0) / 100) / 10;
        text += `\n**Data**: ${syncResult.activities.length} runs (${totalKm}km) over ${days} days\n`;
      }

      if (backfillCount > 0) {
        const remaining = getActivitiesWithoutDetail(1).length;
        text += `**Detail**: Fetched best efforts & laps for ${backfillCount} runs${remaining > 0 ? ` (${remaining} remaining)` : ""}.\n`;
      }

      if (athlete.shoes && athlete.shoes.length > 0) {
        text += `\n**Running Shoes**:\n`;
        for (const shoe of athlete.shoes) {
          const primary = shoe.primary ? " (primary)" : "";
          text += `- ${shoe.name}${primary}: ${Math.round(shoe.distance / 1000)}km\n`;
        }
      }

      text += `\nToday: ${toDateString()}`;

      return toolResult(text);
    } catch (error) {
      return toolError(error);
    }
  }
);

export const stravaAuthTool = tool(
  "strava_auth",
  "Initiates Strava OAuth authorization flow. Opens the user's browser to authorize the app with Strava.",
  {},
  async () => {
    try {
      if (!hasClientCredentials()) {
        return toolResult(`**Strava Setup Required**\n\n1. Go to https://www.strava.com/settings/api\n2. Create an application\n3. Set Authorization Callback Domain to: localhost\n4. Add to .env:\n   STRAVA_CLIENT_ID=<client_id>\n   STRAVA_CLIENT_SECRET=<client_secret>\n\nRestart the app after adding credentials.`, true);
      }

      const tokens = await loadTokens();
      if (tokens?.access_token) {
        return toolResult("Strava is already connected! Use strava_sync to sync activities.");
      }

      const result = await startAutomaticAuth();
      if (!result.success) {
        return toolResult(`Strava authorization failed: ${result.error || "Unknown error"}`, true);
      }

      return toolResult("**Strava Connected Successfully!** Use strava_profile to fetch running data.");
    } catch (error) {
      return toolError(error);
    }
  }
);

export const queryActivitiesTool = tool(
  "query_activities",
  "Runs a SQL SELECT query against the activities database. Tables: 'activities' (summary data), 'activity_laps' (per-lap splits with elevation), 'activity_analysis' (pre-computed per-run analysis: hill_category, grade_adjusted_pace, comparison metrics — JOIN on activity_id), 'activity_stream_analysis' (stream-derived metrics: hr_zone1_s..hr_zone5_s, cardiac_drift_pct, pace_variability_cv, split_type, trimp, ngp_sec_per_km, fatigue_index_pct, cadence_drift_spm, efficiency_factor, phases JSON, intervals JSON — JOIN on activity_id), 'activity_streams' (per-second data — use get_activity_streams tool instead), 'best_efforts' (PRs). Use get_run_analysis tool for structured per-run analysis data.",
  {
    query: z.string().describe("SQL SELECT query. Can query activities, activity_laps (activity_id, lap_index, distance, elapsed_time, moving_time, average_speed, max_speed, average_heartrate, max_heartrate, elevation_gain, elevation_loss), and best_efforts tables."),
  },
  async ({ query }) => {
    try {
      const results = queryActivities(query);
      return toolResult(JSON.stringify(results, null, 2));
    } catch (error) {
      return toolError(error);
    }
  }
);

const ATTRIBUTION = "\n🏃 RunnAI → severi.github.io/runnai";

export const stravaUpdateActivityTool = tool(
  "strava_update_activity",
  "Updates a Strava activity's name, description, or private note. Use after analyzing a workout to write AI analysis back to Strava. IMPORTANT: Always preview changes with the athlete and get explicit confirmation before calling this tool.",
  {
    activity_id: z.number().describe("Strava activity ID"),
    name: z.string().optional().describe("New activity name (e.g. 'Easy Recovery 8K', 'Tempo 10K - Progression Finish')"),
    description: z.string().optional().describe("Activity description — AI analysis with athlete notes. Attribution is appended automatically."),
  },
  async ({ activity_id, name, description }) => {
    try {
      if (!name && !description) {
        return toolResult("Nothing to update — provide at least a name or description.", true);
      }

      const update: { name?: string; description?: string } = {};
      if (name) update.name = name;
      if (description) update.description = description + ATTRIBUTION;

      const result = await updateActivity(activity_id, update);

      if (!result.success) {
        if (result.needsReauth) {
          return toolResult(`${result.error}\n\nThe athlete needs to re-authorize Strava with write permissions. Use strava_auth to start the OAuth flow.`, true);
        }
        return toolResult(`Failed to update activity: ${result.error}`, true);
      }

      const parts: string[] = [];
      if (name) parts.push(`name → "${name}"`);
      if (description) parts.push("description updated");
      return toolResult(`Activity ${activity_id} updated: ${parts.join(", ")}`);
    } catch (error) {
      return toolError(error);
    }
  }
);
