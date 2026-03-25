import * as fs from "fs/promises";
import * as path from "path";
import { getDataDir } from "./paths.js";
import { syncActivities, fetchActivityDetail, fetchActivityStream, convertStravaBestEfforts } from "../strava/client.js";
import {
  getExistingActivityIds,
  getActivitiesWithoutDetail,
  getActivityLaps,
  setRunType,
  getUnclassifiedActivities,
  saveActivityStreams,
  upsertStravaBestEfforts,
  markActivityDetailFetched,
  upsertActivityLaps,
  computeLapElevation,
  saveActivityWeather,
} from "./activities-db.js";
import {
  computeActivityAnalysis,
  saveActivityAnalysis,
  getRecentUnanalyzedActivityIds,
} from "./activity-analysis.js";
import { fetchActivityWeather } from "./activity-weather.js";
import { loadHrZones, computeEasyPaceRef } from "./hr-zones.js";
import { classifyRun, detectHillProfile } from "./run-classifier.js";
import { generateTrainingPatterns } from "./training-patterns.js";
import { toDateString, formatPace } from "./format.js";
import { extractPlanWeeks } from "./plan-parser.js";
import type { ActivityLapRecord, ActivityStream } from "../types/index.js";

export interface StartupContext {
  sync: {
    status: "up_to_date" | "new_activities" | "error";
    message: string;
    newRunIds: number[];
    needsAuth?: boolean;
  };
  recentSummary: string;
  planExcerpt: {
    name: string;
    currentWeek: string;
    nextWeek: string;
  } | null;
  raceCountdowns: {
    name: string;
    date: string;
    daysAway: number;
    weeksAway: number;
  }[];
}

const MONTHS: Record<string, number> = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
  Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
};

const MONTHS_LONG: Record<string, number> = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
};

export function parseRaceCountdowns(
  contextContent: string,
  today: Date = new Date()
): StartupContext["raceCountdowns"] {
  const countdowns: StartupContext["raceCountdowns"] = [];
  const lines = contextContent.split("\n");
  let inRaces = false;

  for (const line of lines) {
    if (line.match(/^##\s+Target Races/i)) {
      inRaces = true;
      continue;
    }
    if (inRaces && line.match(/^##\s/)) break;

    if (!inRaces || !line.startsWith("- ")) continue;

    const match = line.match(/\*\*(.+?)\*\*\s*—\s*([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/);
    if (!match) continue;

    const [, name, monthStr, dayStr, yearStr] = match;
    const monthIdx = MONTHS[monthStr];
    if (monthIdx === undefined) continue;

    const raceDate = new Date(parseInt(yearStr), monthIdx, parseInt(dayStr));
    const todayMs = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
    const raceMs = raceDate.getTime();
    const daysAway = Math.round((raceMs - todayMs) / (1000 * 60 * 60 * 24));
    const weeksAway = Math.round(daysAway / 7);

    if (daysAway < 0) continue;

    const mm = String(raceDate.getMonth() + 1).padStart(2, "0");
    const dd = String(raceDate.getDate()).padStart(2, "0");

    countdowns.push({
      name,
      date: `${yearStr}-${mm}-${dd}`,
      daysAway,
      weeksAway,
    });
  }

  return countdowns;
}

function extractYear(markdown: string): number {
  const headerLines = markdown.split("\n").slice(0, 20);
  for (const line of headerLines) {
    const match = line.match(/\b(20\d{2})\b/);
    if (match) return parseInt(match[1], 10);
  }
  return new Date().getFullYear();
}

export function findCurrentWeekNumber(planContent: string, today: Date = new Date()): number | null {
  const lines = planContent.split("\n");
  const todayMs = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const year = extractYear(planContent);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const datesMatch = line.match(/\*\*Dates:\*\*\s*\w+\s+(\w+)\s+(\d{1,2})\s*[-–]\s*\w+\s+(\w+)\s+(\d{1,2})/i);
    if (!datesMatch) continue;

    const [, startMonth, startDay, endMonth, endDay] = datesMatch;
    const startIdx = MONTHS_LONG[startMonth.toLowerCase()];
    const endIdx = MONTHS_LONG[endMonth.toLowerCase()];
    if (startIdx === undefined || endIdx === undefined) continue;

    const weekStart = new Date(year, startIdx, parseInt(startDay));
    const weekEnd = new Date(year, endIdx, parseInt(endDay));
    weekEnd.setHours(23, 59, 59, 999);

    if (todayMs >= weekStart.getTime() && todayMs <= weekEnd.getTime()) {
      for (let j = i; j >= 0; j--) {
        const weekMatch = lines[j].match(/^##\s+Week\s+(\d+)\b/i);
        if (weekMatch) return parseInt(weekMatch[1], 10);
      }
    }
  }
  return null;
}

async function fetchAndStoreDetail(activityId: number): Promise<ActivityStream | undefined> {
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
    // best-effort
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

export async function startupSync(): Promise<StartupContext> {
  const dataDir = getDataDir();
  const today = new Date();

  // 1. Run incremental Strava sync
  let syncStatus: StartupContext["sync"];
  try {
    const existingIds = getExistingActivityIds();
    const syncResult = await syncActivities(30, undefined, true);

    if (!syncResult.success) {
      syncStatus = {
        status: "error",
        message: syncResult.error || "Sync failed",
        newRunIds: [],
        needsAuth: syncResult.needsAuth,
      };
    } else {
      const activities = syncResult.allActivities ?? [];
      const newActivities = activities.filter(a => !existingIds.has(a.id));
      const newRuns = newActivities.filter(a => (a.type === "Run" || a.sport_type === "Run") && !a.trainer);

      if (newActivities.length === 0) {
        syncStatus = {
          status: "up_to_date",
          message: "Already up to date. No new activities since last sync.",
          newRunIds: [],
        };
      } else {
        // Process new activities: detail, classification, weather
        const cachedStreams = new Map<number, ActivityStream>();
        for (const run of newRuns) {
          try {
            const streams = await fetchAndStoreDetail(run.id);
            if (streams) cachedStreams.set(run.id, streams);
            await new Promise(r => setTimeout(r, 50));
          } catch (e) {
            if (e instanceof Error && e.message === "RATE_LIMITED") break;
          }
        }

        // Backfill historical detail
        const toBackfill = getActivitiesWithoutDetail(100);
        for (const activity of toBackfill) {
          try {
            await fetchAndStoreDetail(activity.id);
            await new Promise(r => setTimeout(r, 100));
          } catch (e) {
            if (e instanceof Error && e.message === "RATE_LIMITED") break;
          }
        }

        // Classify + analyze
        try {
          const zones = await loadHrZones();
          if (zones.confirmed) {
            const easyPaceRef = computeEasyPaceRef();
            for (const run of newRuns) {
              const result = computeActivityAnalysis(run.id, zones, easyPaceRef, cachedStreams.get(run.id));
              if (result) {
                saveActivityAnalysis(result.analysis);
                setRunType(run.id, result.analysis.run_type, result.analysis.run_type_detail);
              }
            }
            const toAnalyze = getRecentUnanalyzedActivityIds(7);
            for (const actId of toAnalyze) {
              const result = computeActivityAnalysis(actId, zones, easyPaceRef);
              if (result) {
                saveActivityAnalysis(result.analysis);
                setRunType(actId, result.analysis.run_type, result.analysis.run_type_detail);
              }
            }
            const unclassified = getUnclassifiedActivities(50);
            for (const a of unclassified) {
              const laps = getActivityLaps(a.id);
              const hill = detectHillProfile(laps, a.distance);
              const cls = classifyRun(
                { id: a.id, distance: a.distance, moving_time: a.moving_time, average_speed: a.average_speed, average_heartrate: a.average_heartrate, workout_type: a.workout_type },
                laps, zones, easyPaceRef, hill
              );
              setRunType(a.id, cls.run_type, cls.run_type_detail);
            }
            await generateTrainingPatterns();
          }
        } catch {
          // best-effort
        }

        // Weather for new runs only (no backfill)
        for (const run of newRuns) {
          if (!run.start_latlng?.[0]) continue;
          try {
            const weather = await fetchActivityWeather(
              run.id, run.start_latlng[0], run.start_latlng[1],
              run.start_date_local, run.moving_time
            );
            if (weather) saveActivityWeather(weather);
          } catch {}
          await new Promise(r => setTimeout(r, 50));
        }

        // Build sync message
        const newRunDistance = Math.round(newRuns.reduce((s, r) => s + r.distance, 0) / 100) / 10;
        let msg = `${newActivities.length} new activit${newActivities.length === 1 ? "y" : "ies"} synced (${newRuns.length} run${newRuns.length !== 1 ? "s" : ""}, ${newRunDistance}km).`;
        if (newRuns.length > 0) {
          msg += "\n\nNew runs:";
          for (const run of newRuns) {
            const date = toDateString(new Date(run.start_date_local));
            const distKm = Math.round(run.distance / 100) / 10;
            const paceSecPerKm = run.distance > 0 ? (run.moving_time / run.distance) * 1000 : 0;
            msg += `\n- ${date}: "${run.name}" (id: ${run.id}) — ${distKm}km @ ${formatPace(paceSecPerKm)}`;
          }
        }

        syncStatus = {
          status: "new_activities",
          message: msg,
          newRunIds: newRuns.map(r => r.id),
        };
      }
    }
  } catch (error) {
    syncStatus = {
      status: "error",
      message: error instanceof Error ? error.message : String(error),
      newRunIds: [],
    };
  }

  // 2. Read recent summary (already regenerated by syncActivities)
  const summaryPath = path.join(dataDir, "strava/recent-summary.md");
  let recentSummary = "";
  try {
    recentSummary = await fs.readFile(summaryPath, "utf-8");
  } catch {}

  // 3. Load plan excerpt (current + next week)
  let planExcerpt: StartupContext["planExcerpt"] = null;
  try {
    const plansDir = path.join(dataDir, "plans");
    const planFiles = await fs.readdir(plansDir);
    const mdFiles = planFiles.filter(f => f.endsWith(".md"));
    if (mdFiles.length > 0) {
      let bestFile = mdFiles[0];
      let bestMtime = 0;
      for (const f of mdFiles) {
        const stat = await fs.stat(path.join(plansDir, f));
        if (stat.mtimeMs > bestMtime) {
          bestMtime = stat.mtimeMs;
          bestFile = f;
        }
      }
      const planContent = await fs.readFile(path.join(plansDir, bestFile), "utf-8");
      const planName = bestFile.replace(".md", "");
      const currentWeekNum = findCurrentWeekNumber(planContent, today);
      if (currentWeekNum !== null) {
        const weeksToExtract = [currentWeekNum, currentWeekNum + 1];
        const excerpts = extractPlanWeeks(planContent, weeksToExtract);
        const current = excerpts.find(e => e.weekNumber === currentWeekNum);
        const next = excerpts.find(e => e.weekNumber === currentWeekNum + 1);
        if (current) {
          planExcerpt = {
            name: planName,
            currentWeek: current.markdown,
            nextWeek: next?.markdown ?? "",
          };
        }
      }
    }
  } catch {}

  // 4. Parse race countdowns from CONTEXT.md
  let raceCountdowns: StartupContext["raceCountdowns"] = [];
  try {
    const contextPath = path.join(dataDir, "athlete/CONTEXT.md");
    const contextContent = await fs.readFile(contextPath, "utf-8");
    raceCountdowns = parseRaceCountdowns(contextContent, today);
  } catch {}

  return { sync: syncStatus, recentSummary, planExcerpt, raceCountdowns };
}

export function formatStartupGreeting(ctx: StartupContext): string {
  const parts: string[] = [];
  parts.push("[Session start — no new activities]");
  parts.push("");
  parts.push("Give a brief, warm coaching greeting (2-4 sentences max). Reference this week's plan and race countdown from the system prompt. Be specific — mention what's coming up today or this week. Do NOT use any tools. Do NOT give a long breakdown. Just a quick, personalized check-in.");
  if (ctx.raceCountdowns.length > 0) {
    parts.push("");
    parts.push("Race countdowns:");
    for (const r of ctx.raceCountdowns) {
      parts.push(`- ${r.name}: ${r.daysAway} days (${r.weeksAway} weeks)`);
    }
  }
  return parts.join("\n");
}

export function formatCompactStatus(ctx: StartupContext): string {
  const lines: string[] = [];

  // Sync status
  if (ctx.sync.status === "error") {
    lines.push(`✗ ${ctx.sync.message}${ctx.sync.needsAuth ? " — run /strava-auth" : ""}`);
  } else if (ctx.sync.status === "new_activities") {
    lines.push(`↓ ${ctx.sync.message.split("\n")[0]}`);
  } else {
    lines.push("✓ Synced — no new activities");
  }

  // Race countdowns
  if (ctx.raceCountdowns.length > 0) {
    const races = ctx.raceCountdowns.map(r => `**${r.name}** in ${r.daysAway} days`).join(" · ");
    lines.push(races);
  }

  // Plan excerpt — compact summary
  if (ctx.planExcerpt) {
    const firstLine = ctx.planExcerpt.currentWeek.split("\n")[0] || "";
    const weekTitle = firstLine.replace(/^#+\s*/, "");
    const sessions = ctx.planExcerpt.currentWeek
      .split("\n")
      .filter(line => line.startsWith("|") && !line.startsWith("|--") && !line.match(/^\|\s*(Day|Date)\s*\|/i))
      .map(line => {
        const cols = line.split("|").filter(Boolean).map(c => c.trim());
        if (cols.length >= 3 && cols[2].toLowerCase() !== "rest") return `${cols[0]}: ${cols[2]}`;
        return null;
      })
      .filter(Boolean);
    if (weekTitle) lines.push(`**${weekTitle}** — ${sessions.join(" · ")}`);
  }

  return lines.join("\n");
}

export function formatNewRunsPrompt(ctx: StartupContext): string {
  return `New runs synced — analyze each one following the "New Run Analysis" steps in your instructions.

${ctx.sync.message}`;
}
