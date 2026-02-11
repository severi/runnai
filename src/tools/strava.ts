import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import * as fs from "fs/promises";
import * as path from "path";
import { fileURLToPath } from "url";
import {
  startAutomaticAuth,
  hasClientCredentials,
  getAccessToken,
  getAuthUrl,
  syncActivities,
  getAthleteProfile,
  fetchActivityDetail,
  convertStravaBestEfforts,
  updateActivity,
} from "../strava/client.js";
import {
  upsertActivities,
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
} from "../utils/activities-db.js";
import { generateRecentSummary } from "../utils/recent-summary.js";
import { loadHrZones, computeEasyPaceRef } from "../utils/hr-zones.js";
import { classifyRun } from "../utils/run-classifier.js";
import { generateTrainingPatterns } from "../utils/training-patterns.js";
import type { StravaActivity, StravaTokens, ActivityLapRecord } from "../types/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "../..");
const STRAVA_DATA_DIR = path.join(PROJECT_ROOT, "data/strava");
const TOKENS_FILE = path.join(STRAVA_DATA_DIR, "tokens.json");

async function loadTokens(): Promise<StravaTokens | null> {
  try {
    const data = await fs.readFile(TOKENS_FILE, "utf-8");
    return JSON.parse(data);
  } catch {
    return null;
  }
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
      let existingIds: Set<number> = new Set();
      let isIncremental = false;

      // Determine the `after` epoch for the Strava API
      let after: number;
      if (incremental) {
        const latestDate = getLatestActivityDate();
        if (latestDate) {
          // Use the last activity's timestamp directly — more precise than day math
          after = Math.floor(new Date(latestDate).getTime() / 1000) - 1;
          existingIds = getExistingActivityIds();
          isIncremental = true;
        } else {
          // First sync ever — fetch 180 days of history
          after = Math.floor(Date.now() / 1000) - 180 * 24 * 60 * 60;
        }
      } else {
        after = Math.floor(Date.now() / 1000) - days * 24 * 60 * 60;
      }

      const accessToken = await getAccessToken();
      const activities: StravaActivity[] = [];
      let page = 1;

      while (true) {
        const response = await fetch(
          `https://www.strava.com/api/v3/athlete/activities?after=${after}&per_page=200&page=${page}`,
          { headers: { Authorization: `Bearer ${accessToken}` } }
        );

        if (!response.ok) {
          throw new Error(`Strava API error: ${await response.text()}`);
        }

        const batch = (await response.json()) as StravaActivity[];
        activities.push(...batch);

        if (batch.length < 200) break;
        page++;
      }

      await fs.mkdir(STRAVA_DATA_DIR, { recursive: true });
      upsertActivities(activities);
      await generateRecentSummary();

      const newActivities = activities.filter((a) => !existingIds.has(a.id));
      const newRuns = newActivities.filter((a) => (a.type === "Run" || a.sport_type === "Run") && !a.trainer);
      const newNonRuns = newActivities.filter((a) => !((a.type === "Run" || a.sport_type === "Run") && !a.trainer));
      const allRuns = activities.filter((a) => a.type === "Run" || a.sport_type === "Run");

      // Fetch best efforts + laps from Strava detail API for new runs
      let detailFetched = 0;
      for (const run of newRuns) {
        try {
          const detail = await fetchActivityDetail(run.id);
          if (detail.bestEfforts.length > 0) {
            const records = convertStravaBestEfforts(run.id, detail.bestEfforts);
            upsertStravaBestEfforts(records);
          }
          if (detail.laps.length > 0) {
            const lapRecords: ActivityLapRecord[] = detail.laps.map(lap => ({
              activity_id: run.id,
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
            }));
            upsertActivityLaps(run.id, lapRecords);
          }
          markActivityDetailFetched(run.id);
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
            const detail = await fetchActivityDetail(activity.id);
            if (detail.bestEfforts.length > 0) {
              const records = convertStravaBestEfforts(activity.id, detail.bestEfforts);
              upsertStravaBestEfforts(records);
            }
            if (detail.laps.length > 0) {
              const lapRecords: ActivityLapRecord[] = detail.laps.map(lap => ({
                activity_id: activity.id,
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
              }));
              upsertActivityLaps(activity.id, lapRecords);
            }
            markActivityDetailFetched(activity.id);
            backfillCount++;
            await new Promise((resolve) => setTimeout(resolve, 100));
          } catch (error) {
            if (error instanceof Error && error.message === "RATE_LIMITED") break;
          }
        }
      }

      // Classify runs (only if HR zones are confirmed)
      // Track classification results for new runs so we can include them in output
      const classificationMap = new Map<number, { run_type: string; run_type_detail: string | null }>();
      let classifiedCount = 0;
      let zonesNeedConfirmation = false;
      let estimatedZones: { lt1: number; lt2: number; max_hr: number } | null = null;
      try {
        const zones = await loadHrZones();

        if (!zones.confirmed) {
          zonesNeedConfirmation = true;
          estimatedZones = { lt1: zones.lt1, lt2: zones.lt2, max_hr: zones.max_hr };
        } else {
          const easyPaceRef = computeEasyPaceRef();

          // Classify newly fetched runs
          for (const run of newRuns) {
            const laps = getActivityLaps(run.id);
            const result = classifyRun(
              { id: run.id, distance: run.distance, moving_time: run.moving_time, average_speed: run.average_speed, average_heartrate: run.average_heartrate ?? null, workout_type: run.workout_type ?? null },
              laps, zones, easyPaceRef
            );
            setRunType(run.id, result.run_type, result.run_type_detail);
            classificationMap.set(run.id, { run_type: result.run_type, run_type_detail: result.run_type_detail });
            classifiedCount++;
          }

          // Backfill: classify runs with detail_fetched=1 but run_type=NULL
          const unclassified = getUnclassifiedActivities(50);
          for (const a of unclassified) {
            const laps = getActivityLaps(a.id);
            const result = classifyRun(
              { id: a.id, distance: a.distance, moving_time: a.moving_time, average_speed: a.average_speed, average_heartrate: a.average_heartrate, workout_type: a.workout_type },
              laps, zones, easyPaceRef
            );
            setRunType(a.id, result.run_type, result.run_type_detail);
            classifiedCount++;
          }

          // Regenerate training patterns
          await generateTrainingPatterns();
        }
      } catch {
        // Classification is best-effort, don't fail the sync
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
              const date = run.start_date_local.split("T")[0];
              const distKm = Math.round(run.distance / 100) / 10;
              const paceMinPerKm = run.moving_time / 60 / (run.distance / 1000);
              const paceMin = Math.floor(paceMinPerKm);
              const paceSec = Math.round((paceMinPerKm - paceMin) * 60);
              const cls = classificationMap.get(run.id);
              const tag = cls ? (cls.run_type_detail ? ` [${cls.run_type}: ${cls.run_type_detail}]` : ` [${cls.run_type}]`) : "";
              text += `\n- ${date}: "${run.name}" — ${distKm}km @ ${paceMin}:${paceSec.toString().padStart(2, "0")}/km${tag}`;
            }
          }
          if (newNonRuns.length > 0) {
            text += `\n\nOther new activities:`;
            for (const act of newNonRuns) {
              const date = act.start_date_local.split("T")[0];
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
        const date = mostRecentRun.start_date_local.split("T")[0];
        const distKm = Math.round(mostRecentRun.distance / 100) / 10;
        const paceMinPerKm = mostRecentRun.moving_time / 60 / (mostRecentRun.distance / 1000);
        const paceMin = Math.floor(paceMinPerKm);
        const paceSec = Math.round((paceMinPerKm - paceMin) * 60);
        text += `\n\nMost recent run: ${date} "${mostRecentRun.name}" - ${distKm}km @ ${paceMin}:${paceSec.toString().padStart(2, "0")}/km`;
      }

      if (detailFetched > 0) {
        text += `\nBest efforts fetched for ${detailFetched} new run${detailFetched > 1 ? "s" : ""}.`;
      }
      if (backfillCount > 0) {
        const remaining = getActivitiesWithoutDetail(1).length;
        text += `\nBackfilled best efforts for ${backfillCount} historical run${backfillCount > 1 ? "s" : ""}${remaining > 0 ? ` (${remaining} remaining)` : " (all done)"}.`;
      }
      if (classifiedCount > 0) {
        text += `\nClassified ${classifiedCount} run${classifiedCount > 1 ? "s" : ""}.`;
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

      text += `\n\nRecent summary updated. Today: ${new Date().toISOString().split("T")[0]}`;

      return { content: [{ type: "text" as const, text }] };
    } catch (error) {
      return {
        content: [{ type: "text" as const, text: `Error syncing Strava: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
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
        return {
          content: [{ type: "text" as const, text: profileResult.error || "Failed to fetch profile" }],
          isError: true,
        };
      }
      const athlete = profileResult.athlete;

      const syncResult = await syncActivities(days);

      // Backfill activity detail (best efforts, laps) for runs that don't have it yet
      let backfillCount = 0;
      const toBackfill = getActivitiesWithoutDetail(100);
      for (const activity of toBackfill) {
        try {
          const detail = await fetchActivityDetail(activity.id);
          if (detail.bestEfforts.length > 0) {
            const records = convertStravaBestEfforts(activity.id, detail.bestEfforts);
            upsertStravaBestEfforts(records);
          }
          if (detail.laps.length > 0) {
            const lapRecords: ActivityLapRecord[] = detail.laps.map(lap => ({
              activity_id: activity.id,
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
            }));
            upsertActivityLaps(activity.id, lapRecords);
          }
          markActivityDetailFetched(activity.id);
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

      text += `\nToday: ${new Date().toISOString().split("T")[0]}`;

      return { content: [{ type: "text" as const, text }] };
    } catch (error) {
      return {
        content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
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
        return {
          content: [{
            type: "text" as const,
            text: `**Strava Setup Required**\n\n1. Go to https://www.strava.com/settings/api\n2. Create an application\n3. Set Authorization Callback Domain to: localhost\n4. Add to .env:\n   STRAVA_CLIENT_ID=<client_id>\n   STRAVA_CLIENT_SECRET=<client_secret>\n\nRestart the app after adding credentials.`,
          }],
          isError: true,
        };
      }

      const tokens = await loadTokens();
      if (tokens?.access_token) {
        return {
          content: [{ type: "text" as const, text: "Strava is already connected! Use strava_sync to sync activities." }],
        };
      }

      const result = await startAutomaticAuth();
      if (!result.success) {
        return {
          content: [{ type: "text" as const, text: `Strava authorization failed: ${result.error || "Unknown error"}` }],
          isError: true,
        };
      }

      return {
        content: [{ type: "text" as const, text: "**Strava Connected Successfully!** Use strava_profile to fetch running data." }],
      };
    } catch (error) {
      return {
        content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  }
);

export const queryActivitiesTool = tool(
  "query_activities",
  "Runs a SQL SELECT query against the activities database. Tables: 'activities' (summary data), 'activity_laps' (per-lap splits with distance, pace, HR — JOIN on activity_id), 'best_efforts' (PRs for standard distances).",
  {
    query: z.string().describe("SQL SELECT query. Can query activities, activity_laps (activity_id, lap_index, distance, elapsed_time, moving_time, average_speed, max_speed, average_heartrate, max_heartrate), and best_efforts tables."),
  },
  async ({ query }) => {
    try {
      const results = queryActivities(query);
      return { content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }] };
    } catch (error) {
      return {
        content: [{ type: "text" as const, text: `Query error: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  }
);

const ATTRIBUTION = "\n\nAnalysis by RunnAI · github.com/severi/runnai";

export const stravaUpdateActivityTool = tool(
  "strava_update_activity",
  "Updates a Strava activity's name, description, or private note. Use after analyzing a workout to write AI analysis back to Strava. IMPORTANT: Always preview changes with the athlete and get explicit confirmation before calling this tool.",
  {
    activity_id: z.number().describe("Strava activity ID"),
    name: z.string().optional().describe("New activity name (e.g. 'Easy Recovery 8K', 'Tempo 10K — Progression Finish')"),
    description: z.string().optional().describe("Activity description — AI analysis with athlete notes. Attribution is appended automatically."),
  },
  async ({ activity_id, name, description }) => {
    try {
      if (!name && !description) {
        return {
          content: [{ type: "text" as const, text: "Nothing to update — provide at least a name or description." }],
          isError: true,
        };
      }

      const update: { name?: string; description?: string } = {};
      if (name) update.name = name;
      if (description) update.description = description + ATTRIBUTION;

      const result = await updateActivity(activity_id, update);

      if (!result.success) {
        if (result.needsReauth) {
          return {
            content: [{ type: "text" as const, text: `${result.error}\n\nThe athlete needs to re-authorize Strava with write permissions. Use strava_auth to start the OAuth flow.` }],
            isError: true,
          };
        }
        return {
          content: [{ type: "text" as const, text: `Failed to update activity: ${result.error}` }],
          isError: true,
        };
      }

      const parts: string[] = [];
      if (name) parts.push(`name → "${name}"`);
      if (description) parts.push("description updated");
      return {
        content: [{ type: "text" as const, text: `Activity ${activity_id} updated: ${parts.join(", ")}` }],
      };
    } catch (error) {
      return {
        content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  }
);
