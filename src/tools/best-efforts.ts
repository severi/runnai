import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import * as fs from "fs/promises";
import { Database } from "bun:sqlite";
import {
  upsertBestEffort,
  getStravaBestEfforts,
  getPersonalRecords,
  getActivitiesDbPath,
  getActivityLaps,
  getActivityStreams,
} from "../utils/activities-db.js";
import type { ActivityStream, BestEffortResult, ActivityLapRecord } from "../types/index.js";
import { formatTime, formatPace as formatPacePerKm } from "../utils/format.js";

const DISTANCE_TOLERANCE = 50;

const MIN_REALISTIC_PACE_PER_KM: Record<number, number> = {
  1000: 2.5 * 60,
  5000: 3.0 * 60,
  10000: 3.0 * 60,
  21097: 3.0 * 60,
  42195: 3.0 * 60,
};

// Maps user-facing param → { db name for strava_best_efforts, target meters }
const DISTANCE_CONFIG: Record<string, { dbName: string; meters: number }> = {
  "1k": { dbName: "1K", meters: 1000 },
  "5k": { dbName: "5K", meters: 5000 },
  "10k": { dbName: "10K", meters: 10000 },
  half: { dbName: "HALF", meters: 21097 },
  marathon: { dbName: "MARATHON", meters: 42195 },
};

interface Activity {
  id: number;
  name: string;
  start_date_local: string;
  distance: number;
  moving_time: number;
  workout_type: number | null;
  run_type: string | null;
}

/** Phase grouping threshold: laps within this pace range (sec/km) are grouped together */
const PHASE_PACE_TOLERANCE = 20;

function lapPaceSecPerKm(lap: ActivityLapRecord): number {
  if (lap.distance <= 0) return 0;
  return (lap.moving_time / lap.distance) * 1000;
}

function fmtPace(secPerKm: number): string {
  const m = Math.floor(secPerKm / 60);
  const s = Math.round(secPerKm % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function groupLapPhases(laps: ActivityLapRecord[]): string {
  if (laps.length === 0) return "";

  const phases: { minPace: number; maxPace: number; count: number }[] = [];
  let currentPhase = {
    minPace: lapPaceSecPerKm(laps[0]),
    maxPace: lapPaceSecPerKm(laps[0]),
    count: 1,
  };

  for (let i = 1; i < laps.length; i++) {
    const pace = lapPaceSecPerKm(laps[i]);
    // Check if this lap fits in the current phase
    const phaseAvg = (currentPhase.minPace + currentPhase.maxPace) / 2;
    if (Math.abs(pace - phaseAvg) <= PHASE_PACE_TOLERANCE) {
      currentPhase.minPace = Math.min(currentPhase.minPace, pace);
      currentPhase.maxPace = Math.max(currentPhase.maxPace, pace);
      currentPhase.count++;
    } else {
      phases.push(currentPhase);
      currentPhase = { minPace: pace, maxPace: pace, count: 1 };
    }
  }
  phases.push(currentPhase);

  return phases
    .map((p) => {
      const paceRange =
        p.minPace === p.maxPace || Math.abs(p.maxPace - p.minPace) < 5
          ? fmtPace((p.minPace + p.maxPace) / 2)
          : `${fmtPace(p.minPace)}-${fmtPace(p.maxPace)}`;
      return `${paceRange} (${p.count})`;
    })
    .join(" | ");
}

function formatCompactLaps(laps: ActivityLapRecord[]): string | null {
  if (laps.length === 0) return null;

  let paceStr: string;
  if (laps.length <= 15) {
    paceStr = laps.map((l) => fmtPace(lapPaceSecPerKm(l))).join(" ");
  } else {
    paceStr = groupLapPhases(laps);
  }

  // HR trend: first → peak → last
  const hrsWithValues = laps.filter((l) => l.average_heartrate !== null);
  let hrStr = "";
  if (hrsWithValues.length >= 3) {
    const first = Math.round(hrsWithValues[0].average_heartrate!);
    const peak = Math.round(
      Math.max(...hrsWithValues.map((l) => l.average_heartrate!))
    );
    const last = Math.round(
      hrsWithValues[hrsWithValues.length - 1].average_heartrate!
    );
    hrStr = ` | HR: ${first}->${peak}->${last}`;
  }

  return `Laps (${laps.length}): ${paceStr}${hrStr}`;
}

function formatTimeAgo(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const days = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (days <= 0) return "today";
  if (days === 1) return "1d ago";
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${(days / 365).toFixed(1)}y ago`;
}

function findFastestSegment(
  stream: ActivityStream,
  targetDistance: number
): { timeSeconds: number; distanceMeters: number; startIndex: number; endIndex: number } | null {
  const { time, distance } = stream;

  if (distance.length === 0 || distance[distance.length - 1] < targetDistance) {
    return null;
  }

  let bestTime = Infinity;
  let bestDistance = 0;
  let bestStartIdx = 0;
  let bestEndIdx = 0;
  let startIdx = 0;

  for (let endIdx = 0; endIdx < distance.length; endIdx++) {
    while (
      startIdx < endIdx &&
      distance[endIdx] - distance[startIdx] > targetDistance + DISTANCE_TOLERANCE
    ) {
      startIdx++;
    }

    const segmentDistance = distance[endIdx] - distance[startIdx];

    if (segmentDistance >= targetDistance - DISTANCE_TOLERANCE) {
      const segmentTime = time[endIdx] - time[startIdx];
      const normalizedTime = (segmentTime / segmentDistance) * targetDistance;

      if (normalizedTime < bestTime) {
        bestTime = normalizedTime;
        bestDistance = segmentDistance;
        bestStartIdx = startIdx;
        bestEndIdx = endIdx;
      }
    }
  }

  if (bestTime === Infinity) return null;

  return {
    timeSeconds: Math.round(bestTime),
    distanceMeters: Math.round(bestDistance),
    startIndex: bestStartIdx,
    endIndex: bestEndIdx,
  };
}


function formatDistanceName(meters: number): string {
  if (meters >= 42000) return "Marathon";
  if (meters >= 21000) return "Half Marathon";
  if (meters >= 10000) return `${Math.round(meters / 1000)}K`;
  if (meters >= 1000) return `${(meters / 1000).toFixed(1)}K`;
  return `${meters}m`;
}

function queryStravaEfforts(dist: string, config: { dbName: string; meters: number }, limit: number): BestEffortResult[] {
  const rows = getStravaBestEfforts(config.dbName);
  return rows.slice(0, limit).map((row) => {
    const laps = getActivityLaps(row.activity_id);
    return {
      activityId: row.activity_id,
      activityName: row.activity_name,
      activityDate: row.start_date_local.split("T")[0],
      segmentTimeSeconds: row.elapsed_time,
      segmentDistanceMeters: row.distance_meters,
      formattedTime: formatTime(row.elapsed_time),
      pacePerKm: formatPacePerKm((row.elapsed_time / config.meters) * 1000),
      stravaUrl: `https://www.strava.com/activities/${row.activity_id}`,
      source: "strava" as const,
      activityDistance: row.activity_distance,
      workoutType: row.workout_type,
      runType: row.run_type,
      prRank: row.pr_rank,
      compactLaps: formatCompactLaps(laps),
    };
  });
}

async function computeEfforts(dist: string, config: { dbName: string; meters: number }, limit: number): Promise<BestEffortResult[]> {
  const db = new Database(getActivitiesDbPath(), { readonly: true });
  try {
    const runs = db
      .prepare(
        `SELECT id, name, start_date_local, distance, moving_time, workout_type, run_type
         FROM activities
         WHERE type = 'Run' AND distance >= ? AND trainer = 0
         ORDER BY start_date_local DESC`
      )
      .all(config.meters) as Activity[];

    if (runs.length === 0) return [];

    const efforts: BestEffortResult[] = [];

    for (const run of runs) {
      const stream = getActivityStreams(run.id);
      if (!stream) continue;

      const segment = findFastestSegment(stream, config.meters);
      if (!segment) continue;

      const pacePerKm = (segment.timeSeconds / segment.distanceMeters) * 1000;
      const minPace = MIN_REALISTIC_PACE_PER_KM[config.meters] || 3 * 60;
      if (pacePerKm < minPace) continue;

      upsertBestEffort({
        activity_id: run.id,
        distance_name: config.dbName,
        distance_meters: config.meters,
        elapsed_time: segment.timeSeconds,
        pace_per_km: pacePerKm,
        start_index: segment.startIndex,
        end_index: segment.endIndex,
        computed_at: new Date().toISOString().split("T")[0],
      });

      const laps = getActivityLaps(run.id);
      efforts.push({
        activityId: run.id,
        activityName: run.name,
        activityDate: run.start_date_local.split("T")[0],
        segmentTimeSeconds: segment.timeSeconds,
        segmentDistanceMeters: segment.distanceMeters,
        formattedTime: formatTime(segment.timeSeconds),
        pacePerKm: formatPacePerKm((segment.timeSeconds / config.meters) * 1000),
        stravaUrl: `https://www.strava.com/activities/${run.id}`,
        source: "computed" as const,
        activityDistance: run.distance,
        workoutType: run.workout_type,
        runType: run.run_type,
        prRank: null,
        compactLaps: formatCompactLaps(laps),
      });

      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    efforts.sort((a, b) => a.segmentTimeSeconds - b.segmentTimeSeconds);
    return efforts.slice(0, limit);
  } finally {
    db.close();
  }
}

function mergeEfforts(strava: BestEffortResult[], computed: BestEffortResult[], limit: number): BestEffortResult[] {
  const byActivity = new Map<number, BestEffortResult>();

  // Strava efforts take priority (more accurate)
  for (const e of strava) {
    byActivity.set(e.activityId, e);
  }

  // Add computed efforts only if we don't have a Strava effort for that activity
  for (const e of computed) {
    if (!byActivity.has(e.activityId)) {
      byActivity.set(e.activityId, e);
    }
  }

  const merged = Array.from(byActivity.values());
  merged.sort((a, b) => a.segmentTimeSeconds - b.segmentTimeSeconds);
  return merged.slice(0, limit);
}

export const bestEffortsTool = tool(
  "best_efforts",
  "Find the athlete's fastest times for standard running distances. Returns each effort with compact lap data showing the run structure (pace per km, HR trend). Use the lap patterns to assess whether each effort represents the athlete's true capability for that distance — look for warmup/cooldown structure, even vs variable splits, and fade patterns. Strava native best efforts with GPS stream analysis as fallback.",
  {
    distance: z
      .enum(["1k", "5k", "10k", "half", "marathon", "all"])
      .optional()
      .describe("Distance to analyze. Default: all"),
    limit: z.number().optional().describe("Number of top results per distance. Default: 5"),
    source: z
      .enum(["best", "strava", "computed"])
      .optional()
      .describe("Data source: 'best' (default) merges both, 'strava' uses only Strava native, 'computed' uses only GPS stream analysis"),
  },
  async ({ distance = "all", limit = 5, source = "best" }) => {
    try {
      const distances = distance === "all" ? Object.keys(DISTANCE_CONFIG) : [distance];

      try {
        await fs.access(getActivitiesDbPath());
      } catch {
        return {
          content: [{ type: "text" as const, text: "No activity data found. Please sync Strava first." }],
          isError: true,
        };
      }

      const results: Record<string, BestEffortResult[]> = {};

      for (const dist of distances) {
        const config = DISTANCE_CONFIG[dist];

        if (source === "strava") {
          results[dist] = queryStravaEfforts(dist, config, limit);
        } else if (source === "computed") {
          results[dist] = await computeEfforts(dist, config, limit);
        } else {
          // "best" mode: try Strava first, fall back to computed if no data
          const stravaResults = queryStravaEfforts(dist, config, limit);
          if (stravaResults.length > 0) {
            // We have Strava data — also check computed for any activities not in Strava
            const computedResults = await getComputedFromDb(config);
            results[dist] = mergeEfforts(stravaResults, computedResults, limit);
          } else {
            // No Strava data — fall back to stream computation
            results[dist] = await computeEfforts(dist, config, limit);
          }
        }
      }

      // Fetch declared personal records
      const declaredPRs = getPersonalRecords();
      const prByDistance = new Map(declaredPRs.map(pr => [pr.distance_name, pr]));

      let output = "# Best Efforts\n\n";

      for (const dist of distances) {
        const config = DISTANCE_CONFIG[dist];
        const distName = formatDistanceName(config.meters);
        const efforts = results[dist];
        const declaredPR = prByDistance.get(config.dbName);

        output += `## ${distName}\n\n`;

        // Show declared PR first if it exists
        if (declaredPR) {
          const pacePerKm = declaredPR.time_seconds / (config.meters / 1000);
          const pMin = Math.floor(pacePerKm / 60);
          const pSec = Math.round(pacePerKm % 60);
          output += `**Official PR: ${formatTime(declaredPR.time_seconds)}** (${pMin}:${pSec.toString().padStart(2, "0")}/km) — ${declaredPR.race_name}, ${declaredPR.race_date}\n\n`;
        }

        if (efforts.length === 0 && !declaredPR) {
          output += `No ${distName} efforts found.\n\n`;
          continue;
        }

        if (efforts.length > 0) {
          // Summary table for quick scanning
          output += `| # | Time | Pace | Date | Activity |\n`;
          output += `|---|------|------|------|----------|\n`;

          efforts.forEach((e, i) => {
            const actKm = (e.activityDistance / 1000).toFixed(1);
            const ago = formatTimeAgo(e.activityDate);
            output += `| ${i + 1} | **${e.formattedTime}** | ${e.pacePerKm} | ${e.activityDate} (${ago}) | [${e.activityName}](${e.stravaUrl}) — ${actKm}km total |\n`;
          });

          output += `\n`;

          // Lap detail for LLM analysis
          output += `Lap detail:\n`;
          efforts.forEach((e, i) => {
            if (e.compactLaps) {
              output += `${i + 1}. ${e.formattedTime} "${e.activityName}" — ${e.compactLaps}\n`;
            } else {
              output += `${i + 1}. ${e.formattedTime} "${e.activityName}" — (no lap data)\n`;
            }
          });

          output += `\n`;
        }

        output += `\n`;
      }

      return { content: [{ type: "text" as const, text: output }] };
    } catch (error) {
      return {
        content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  }
);

/** Query already-computed best efforts from the DB (no API calls) */
function getComputedFromDb(config: { dbName: string; meters: number }): BestEffortResult[] {
  const db = new Database(getActivitiesDbPath(), { readonly: true });
  try {
    const rows = db
      .prepare(
        `SELECT be.*, a.name as activity_name, a.start_date_local,
                a.distance as activity_distance, a.workout_type, a.run_type
         FROM best_efforts be
         JOIN activities a ON be.activity_id = a.id
         WHERE be.distance_name = ?
         ORDER BY be.elapsed_time ASC`
      )
      .all(config.dbName) as any[];

    return rows.map((row: any) => {
      const laps = getActivityLaps(row.activity_id);
      return {
        activityId: row.activity_id,
        activityName: row.activity_name,
        activityDate: row.start_date_local.split("T")[0],
        segmentTimeSeconds: row.elapsed_time,
        segmentDistanceMeters: row.distance_meters,
        formattedTime: formatTime(row.elapsed_time),
        pacePerKm: formatPacePerKm((row.elapsed_time / config.meters) * 1000),
        stravaUrl: `https://www.strava.com/activities/${row.activity_id}`,
        source: "computed" as const,
        activityDistance: row.activity_distance,
        workoutType: row.workout_type ?? null,
        runType: row.run_type ?? null,
        prRank: null,
        compactLaps: formatCompactLaps(laps),
      };
    });
  } finally {
    db.close();
  }
}
