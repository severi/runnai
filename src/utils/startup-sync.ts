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
import { extractPlanWeeks, findCurrentWeekNumber, parsePlan } from "./plan-parser.js";
import { findActivePlan, getWeeklyPlanCompliance } from "./plan-compliance.js";
import { computeFitnessDrift } from "./fitness-drift.js";
import type { ActivityLapRecord, ActivityStream, WeeklyComplianceResult, FitnessDriftSignal } from "../types/index.js";

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
  weekCompliance: WeeklyComplianceResult | null;
  newRunPlanContext: Array<{
    runId: number;
    date: string;
    planned: { sessionName: string; details: string; weekNumber: number } | null;
  }>;
  fitnessDrift: FitnessDriftSignal | null;
}

const MONTHS: Record<string, number> = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
  Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
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
  let newRunDates: Array<{ id: number; date: string }> = [];
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

        newRunDates = newRuns.map(r => ({
          id: r.id,
          date: toDateString(new Date(r.start_date_local)),
        }));

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

  // 3. Load plan once, then derive: plan excerpt, weekly compliance, per-run plan context
  let planExcerpt: StartupContext["planExcerpt"] = null;
  let weekCompliance: WeeklyComplianceResult | null = null;
  const newRunPlanContext: StartupContext["newRunPlanContext"] = newRunDates.map(r => ({
    runId: r.id,
    date: r.date,
    planned: null,
  }));
  try {
    const plan = await findActivePlan();
    if (plan) {
      const currentWeekNum = findCurrentWeekNumber(plan.content, today);
      if (currentWeekNum !== null) {
        const wk = currentWeekNum;
        const excerpts = extractPlanWeeks(plan.content, [wk, wk + 1]);
        const current = excerpts.find(e => e.weekNumber === wk);
        const next = excerpts.find(e => e.weekNumber === wk + 1);
        if (current) {
          planExcerpt = {
            name: plan.slug,
            currentWeek: current.markdown,
            nextWeek: next?.markdown ?? "",
          };
        }
        try {
          weekCompliance = await getWeeklyPlanCompliance(wk, today, plan);
        } catch {}
      }

      // Per-run plan context: parse the entire plan once and look up each new run by date.
      // This handles late-synced runs from previous weeks correctly.
      if (newRunDates.length > 0) {
        const allWorkouts = parsePlan(plan.content, plan.slug);
        const byDate = new Map(allWorkouts.map(w => [w.date.slice(0, 10), w]));
        for (const ctx of newRunPlanContext) {
          const planned = byDate.get(ctx.date);
          if (planned) {
            ctx.planned = {
              sessionName: planned.sessionName,
              details: planned.details,
              weekNumber: planned.weekNumber,
            };
          }
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

  // 5. Fitness drift detection — compares recent training-data Z2 pace
  // against stored easy zone in training-zones.json
  let fitnessDrift: FitnessDriftSignal | null = null;
  try {
    fitnessDrift = await computeFitnessDrift(today);
  } catch {}

  return { sync: syncStatus, recentSummary, planExcerpt, raceCountdowns, weekCompliance, newRunPlanContext, fitnessDrift };
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
  if (ctx.fitnessDrift?.should_prompt) {
    parts.push("");
    parts.push("**Fitness drift detected — surface this BEFORE the casual greeting:**");
    parts.push(ctx.fitnessDrift.summary);
    parts.push("Open by flagging the drift and proposing a zone update. Ask the athlete to confirm before calling update_pace_zones. Then continue with the casual check-in.");
  }
  return parts.join("\n");
}

export function formatCompactStatus(ctx: StartupContext): string {
  const sections: string[] = [];

  // Sync status
  if (ctx.sync.status === "error") {
    sections.push(`✗ ${ctx.sync.message}${ctx.sync.needsAuth ? " — run /strava-auth" : ""}`);
  } else if (ctx.sync.status === "new_activities") {
    sections.push(`↓ ${ctx.sync.message.split("\n")[0]}`);
  } else {
    sections.push("✓ Synced · no new activities");
  }

  // Race countdowns — aligned name column
  if (ctx.raceCountdowns.length > 0) {
    const maxName = Math.max(...ctx.raceCountdowns.map(r => r.name.length));
    const rows = ctx.raceCountdowns.map(r => `  ${r.name.padEnd(maxName)}  in ${r.daysAway} days`);
    sections.push(["Races", ...rows].join("\n"));
  }

  // Plan sessions — parse only the first (sessions) table, cut at first ### subheading
  // so Race Week Protocols, Sleep, Carb Loading sub-tables don't contaminate the list.
  // Today's row is highlighted with → and shows the details column inline so the
  // athlete sees km/intensity without having to ask "what's today?".
  if (ctx.planExcerpt) {
    const firstLine = ctx.planExcerpt.currentWeek.split("\n")[0] || "";
    let weekTitle = firstLine.replace(/^#+\s*/, "");
    // Inline compliance stats (X/Y done · Zkm) onto the week title line — avoids
    // a duplicate "Week N" header below.
    if (ctx.weekCompliance && ctx.weekCompliance.entries.length > 0) {
      const { summary } = ctx.weekCompliance;
      const kmSegment = summary.plannedKm
        ? `${summary.completedKm}/${summary.plannedKm}km`
        : `${summary.completedKm}km`;
      weekTitle += ` · ${summary.completed}/${summary.total} done · ${kmSegment}`;
    }
    const weekBody = ctx.planExcerpt.currentWeek.split(/^###\s/m)[0];
    const todayDow = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"][new Date().getDay()];
    const sessions = weekBody
      .split("\n")
      .filter(line => line.startsWith("|") && !line.startsWith("|--") && !line.match(/^\|\s*(Day|Date)\s*\|/i))
      .map(line => {
        const cols = line.split("|").filter(Boolean).map(c => c.trim());
        if (cols.length >= 3 && cols[2].toLowerCase() !== "rest") {
          return {
            day: cols[0],
            session: cols[2],
            details: cols.length >= 4 ? cols[3] : "",
          };
        }
        return null;
      })
      .filter((x): x is { day: string; session: string; details: string } => x !== null);

    if (weekTitle && sessions.length > 0) {
      const maxDay = Math.max(...sessions.map(s => stripMarkdown(s.day).length));
      const rows = sessions.map(s => {
        const dayPlain = stripMarkdown(s.day);
        const sessionPlain = stripMarkdown(s.session);
        const isToday = dayPlain.toLowerCase().slice(0, 3) === todayDow;
        const marker = isToday ? "→ " : "  ";
        const base = `${marker}${dayPlain.padEnd(maxDay)}  ${sessionPlain}`;
        // For today only, append details inline so km/intensity is visible at a glance.
        if (isToday && s.details) {
          return `${base} — ${stripMarkdown(s.details)}`;
        }
        return base;
      });
      const lines = [weekTitle, ...rows];
      // Append missed-session notice (only thing from compliance that isn't already
      // visible in the week table — the table shows what's done/upcoming via ✅, but
      // a session that was scheduled and not done deserves an explicit callout).
      if (ctx.weekCompliance && ctx.weekCompliance.entries.length > 0) {
        const missed = ctx.weekCompliance.entries.filter(e => e.status === "missed");
        if (missed.length > 0) {
          lines.push(`  missed: ${missed.map(e => e.planned.sessionName).join(", ")}`);
        }
      }
      sections.push(lines.join("\n"));
    } else if (weekTitle) {
      sections.push(weekTitle);
    }
  }

  // Fitness drift
  if (ctx.fitnessDrift?.should_prompt) {
    sections.push(`⚡ Fitness drift (${ctx.fitnessDrift.confidence}): ${ctx.fitnessDrift.summary}`);
  }

  return sections.join("\n\n");
}

function stripMarkdown(s: string): string {
  return s.replace(/\*\*/g, "");
}

export function formatNewRunsPrompt(ctx: StartupContext): string {
  let prompt = `New runs synced — analyze each one following the "New Run Analysis" steps in your instructions.

${ctx.sync.message}`;

  // Pair each new run with its planned session so the LLM can compare
  if (ctx.newRunPlanContext.length > 0) {
    const lines: string[] = [];
    for (const entry of ctx.newRunPlanContext) {
      if (entry.planned) {
        lines.push(`- Run ${entry.runId} (${entry.date}, plan week ${entry.planned.weekNumber}) → Planned: **${entry.planned.sessionName}** — ${entry.planned.details}`);
      } else {
        lines.push(`- Run ${entry.runId} (${entry.date}) → No planned session for this date (unplanned run or rest day)`);
      }
    }
    prompt += `\n\n**Plan context — compare each run against what was scheduled:**\n${lines.join("\n")}`;
  }

  // Surface fitness drift signal so the coach addresses it before run analysis
  if (ctx.fitnessDrift?.should_prompt) {
    prompt += `\n\n**Fitness drift detected (${ctx.fitnessDrift.confidence} confidence):**\n${ctx.fitnessDrift.summary}\n\nBefore analyzing the new runs, flag this to the athlete and propose a zone update. Use update_pace_zones AFTER the athlete confirms. Reference get_training_zones for the current values.`;
  }

  return prompt;
}
