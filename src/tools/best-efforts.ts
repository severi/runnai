import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import * as fs from "fs/promises";
import { Database } from "bun:sqlite";
import { fetchActivityStream } from "../strava/client.js";
import {
  upsertBestEffort,
  getStravaBestEfforts,
  ACTIVITIES_DB_PATH,
} from "../utils/activities-db.js";
import type { ActivityStream, BestEffortResult } from "../types/index.js";

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

function formatTime(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.round(seconds % 60);

  if (hours > 0) {
    return `${hours}:${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
  }
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

function formatPace(seconds: number, meters: number): string {
  const paceSecsPerKm = (seconds / meters) * 1000;
  const mins = Math.floor(paceSecsPerKm / 60);
  const secs = Math.round(paceSecsPerKm % 60);
  return `${mins}:${secs.toString().padStart(2, "0")}/km`;
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
  return rows.slice(0, limit).map((row) => ({
    activityId: row.activity_id,
    activityName: row.activity_name,
    activityDate: row.start_date_local.split("T")[0],
    segmentTimeSeconds: row.elapsed_time,
    segmentDistanceMeters: row.distance_meters,
    formattedTime: formatTime(row.elapsed_time),
    pacePerKm: formatPace(row.elapsed_time, config.meters),
    stravaUrl: `https://www.strava.com/activities/${row.activity_id}`,
    source: "strava" as const,
  }));
}

async function computeEfforts(dist: string, config: { dbName: string; meters: number }, limit: number): Promise<BestEffortResult[]> {
  const db = new Database(ACTIVITIES_DB_PATH, { readonly: true });
  try {
    const runs = db
      .prepare(
        `SELECT id, name, start_date_local, distance, moving_time
         FROM activities
         WHERE type = 'Run' AND distance >= ? AND trainer = 0
         ORDER BY start_date_local DESC`
      )
      .all(config.meters) as Activity[];

    if (runs.length === 0) return [];

    const efforts: BestEffortResult[] = [];

    for (const run of runs) {
      const stream = await fetchActivityStream(run.id);
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

      efforts.push({
        activityId: run.id,
        activityName: run.name,
        activityDate: run.start_date_local.split("T")[0],
        segmentTimeSeconds: segment.timeSeconds,
        segmentDistanceMeters: segment.distanceMeters,
        formattedTime: formatTime(segment.timeSeconds),
        pacePerKm: formatPace(segment.timeSeconds, config.meters),
        stravaUrl: `https://www.strava.com/activities/${run.id}`,
        source: "computed" as const,
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
  "Find the athlete's fastest times for standard running distances. Uses Strava's native best efforts (accurate) with GPS stream analysis as fallback.",
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
        await fs.access(ACTIVITIES_DB_PATH);
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

      let output = "# Best Efforts\n\n";

      for (const dist of distances) {
        const config = DISTANCE_CONFIG[dist];
        const distName = formatDistanceName(config.meters);
        const efforts = results[dist];

        output += `## ${distName}\n\n`;

        if (efforts.length === 0) {
          output += `No ${distName} efforts found.\n\n`;
          continue;
        }

        const showSource = source === "best" && efforts.some((e) => e.source === "computed");
        output += `| Rank | Time | Pace | Date | Activity |${showSource ? " Source |" : ""}\n`;
        output += `|------|------|------|------|----------|${showSource ? "--------|" : ""}\n`;

        efforts.forEach((e, i) => {
          output += `| #${i + 1} | **${e.formattedTime}** | ${e.pacePerKm} | ${e.activityDate} | [${e.activityName}](${e.stravaUrl}) |`;
          if (showSource) {
            output += ` ${e.source} |`;
          }
          output += `\n`;
        });

        output += `\n`;

        if (efforts.length > 0) {
          output += `**PR: ${efforts[0].formattedTime}** (${efforts[0].pacePerKm}) from "${efforts[0].activityName}" on ${efforts[0].activityDate}\n\n`;
        }
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
  const db = new Database(ACTIVITIES_DB_PATH, { readonly: true });
  try {
    const rows = db
      .prepare(
        `SELECT be.*, a.name as activity_name, a.start_date_local
         FROM best_efforts be
         JOIN activities a ON be.activity_id = a.id
         WHERE be.distance_name = ?
         ORDER BY be.elapsed_time ASC`
      )
      .all(config.dbName) as any[];

    return rows.map((row: any) => ({
      activityId: row.activity_id,
      activityName: row.activity_name,
      activityDate: row.start_date_local.split("T")[0],
      segmentTimeSeconds: row.elapsed_time,
      segmentDistanceMeters: row.distance_meters,
      formattedTime: formatTime(row.elapsed_time),
      pacePerKm: formatPace(row.elapsed_time, config.meters),
      stravaUrl: `https://www.strava.com/activities/${row.activity_id}`,
      source: "computed" as const,
    }));
  } finally {
    db.close();
  }
}
