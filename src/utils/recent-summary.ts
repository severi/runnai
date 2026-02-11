import { initDatabase } from "./activities-db.js";
import * as fs from "fs/promises";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "../..");
const SUMMARY_FILE = path.join(PROJECT_ROOT, "data/strava/recent-summary.md");

interface RunEntry {
  name: string;
  distance: number;
  paceMinKm: number;
  heartrate: number | null;
  runType: string | null;
  runTypeDetail: string | null;
}

interface WeekData {
  weekStart: string;
  weekEnd: string;
  runs: number;
  totalDistance: number;
  longestRun: { distance: number; name: string } | null;
  runEntries: RunEntry[];
}

interface QuickStats {
  typicalWeeklyVolume: { min: number; max: number };
  runsPerWeek: number;
  longRunDay: string | null;
}

function getWeekRange(date: Date): { start: Date; end: Date } {
  const day = date.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  const start = new Date(date);
  start.setDate(date.getDate() + diff);
  start.setHours(0, 0, 0, 0);

  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  end.setHours(23, 59, 59, 999);

  return { start, end };
}

function formatDate(date: Date): string {
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function formatWeekLabel(weekStart: Date, weekEnd: Date, today: Date): string {
  const todayWeek = getWeekRange(today);

  if (weekStart.getTime() === todayWeek.start.getTime()) {
    return `This Week (${formatDate(weekStart)} - ${formatDate(weekEnd)})`;
  }

  const lastWeek = new Date(todayWeek.start);
  lastWeek.setDate(lastWeek.getDate() - 7);
  if (weekStart.getTime() === lastWeek.getTime()) {
    return `Last Week (${formatDate(weekStart)} - ${formatDate(weekEnd)})`;
  }

  return `Week of ${formatDate(weekStart)} - ${formatDate(weekEnd)}`;
}

export async function generateRecentSummary(): Promise<string> {
  const db = initDatabase();
  const today = new Date();

  try {
    const fourWeeksAgo = new Date(today);
    fourWeeksAgo.setDate(fourWeeksAgo.getDate() - 28);

    const runs = db
      .prepare(`
        SELECT id, name, start_date_local, distance, moving_time,
               average_speed, average_heartrate, max_speed, suffer_score,
               run_type, run_type_detail
        FROM activities
        WHERE (type = 'Run' OR sport_type = 'Run')
          AND start_date_local >= ?
          AND trainer = 0
        ORDER BY start_date_local DESC
      `)
      .all(fourWeeksAgo.toISOString()) as Array<{
        id: number;
        name: string;
        start_date_local: string;
        distance: number;
        moving_time: number;
        average_speed: number | null;
        average_heartrate: number | null;
        max_speed: number | null;
        suffer_score: number | null;
        run_type: string | null;
        run_type_detail: string | null;
      }>;

    const weekMap = new Map<string, WeekData>();

    for (const run of runs) {
      const runDate = new Date(run.start_date_local);
      const { start, end } = getWeekRange(runDate);
      const weekKey = start.toISOString().split("T")[0];

      if (!weekMap.has(weekKey)) {
        weekMap.set(weekKey, {
          weekStart: formatDate(start),
          weekEnd: formatDate(end),
          runs: 0,
          totalDistance: 0,
          longestRun: null,
          runEntries: [],
        });
      }

      const week = weekMap.get(weekKey)!;
      week.runs++;
      week.totalDistance += run.distance;

      const paceMinKm = run.distance > 0
        ? (run.moving_time / 60) / (run.distance / 1000)
        : 0;

      week.runEntries.push({
        name: run.name,
        distance: run.distance,
        paceMinKm,
        heartrate: run.average_heartrate,
        runType: run.run_type,
        runTypeDetail: run.run_type_detail,
      });

      if (!week.longestRun || run.distance > week.longestRun.distance) {
        week.longestRun = { distance: run.distance, name: run.name };
      }
    }

    const sixMonthsAgo = new Date(today);
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

    const historicalWeeks = db
      .prepare(`
        SELECT
          strftime('%Y-%W', start_date_local) as week,
          COUNT(*) as runs,
          SUM(distance) as total_distance,
          strftime('%w', start_date_local) as day_of_week,
          MAX(distance) as max_distance
        FROM activities
        WHERE (type = 'Run' OR sport_type = 'Run')
          AND start_date_local >= ?
        GROUP BY strftime('%Y-%W', start_date_local)
        ORDER BY week DESC
      `)
      .all(sixMonthsAgo.toISOString()) as Array<{
        week: string;
        runs: number;
        total_distance: number;
        day_of_week: string;
        max_distance: number;
      }>;

    const weeklyDistances = historicalWeeks
      .map((w) => w.total_distance / 1000)
      .filter((d) => d > 10);

    let quickStats: QuickStats = {
      typicalWeeklyVolume: { min: 0, max: 0 },
      runsPerWeek: 0,
      longRunDay: null,
    };

    if (weeklyDistances.length > 0) {
      weeklyDistances.sort((a, b) => a - b);
      const q1 = weeklyDistances[Math.floor(weeklyDistances.length * 0.25)];
      const q3 = weeklyDistances[Math.floor(weeklyDistances.length * 0.75)];
      quickStats.typicalWeeklyVolume = { min: Math.round(q1), max: Math.round(q3) };
      quickStats.runsPerWeek = Math.round(
        historicalWeeks.reduce((sum, w) => sum + w.runs, 0) / historicalWeeks.length
      );
    }

    const longRunDays = db
      .prepare(`
        SELECT strftime('%w', start_date_local) as day_of_week, COUNT(*) as count
        FROM activities
        WHERE (type = 'Run' OR sport_type = 'Run')
          AND start_date_local >= ?
          AND distance > 15000
        GROUP BY day_of_week
        ORDER BY count DESC
        LIMIT 1
      `)
      .get(sixMonthsAgo.toISOString()) as { day_of_week: string; count: number } | undefined;

    if (longRunDays) {
      const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
      quickStats.longRunDay = days[parseInt(longRunDays.day_of_week)];
    }

    let md = `# Training Summary (Last 4 Weeks)\n\n`;
    md += `Generated: ${today.toISOString().split("T")[0]}\n\n`;

    const sortedWeeks = Array.from(weekMap.entries())
      .sort(([a], [b]) => b.localeCompare(a))
      .slice(0, 4);

    for (const [weekKey, week] of sortedWeeks) {
      const [year, month, day] = weekKey.split("-").map(Number);
      const weekStart = new Date(year, month - 1, day);
      const weekEnd = new Date(weekStart);
      weekEnd.setDate(weekEnd.getDate() + 6);

      md += `## ${formatWeekLabel(weekStart, weekEnd, today)}\n`;
      md += `- Runs: ${week.runs} | Distance: ${Math.round(week.totalDistance / 1000)}km\n`;
      if (week.longestRun) {
        md += `- Longest: ${Math.round(week.longestRun.distance / 1000)}km (${week.longestRun.name})\n`;
      }
      for (const entry of week.runEntries) {
        const distKm = (entry.distance / 1000).toFixed(1);
        const paceMin = Math.floor(entry.paceMinKm);
        const paceSec = Math.round((entry.paceMinKm - paceMin) * 60);
        const paceStr = `${paceMin}:${paceSec.toString().padStart(2, "0")}/km`;
        const hrStr = entry.heartrate ? ` | HR ${Math.round(entry.heartrate)}` : "";
        let typeTag = "";
        if (entry.runType) {
          typeTag = entry.runTypeDetail ? ` [${entry.runType}: ${entry.runTypeDetail}]` : ` [${entry.runType}]`;
        }
        md += `- ${distKm}km @ ${paceStr}${hrStr}${typeTag} — "${entry.name}"\n`;
      }
      md += `\n`;
    }

    // Cross-training activities (non-run) from last 4 weeks
    const crossTraining = db
      .prepare(`
        SELECT name, type, sport_type, start_date_local, distance, moving_time
        FROM activities
        WHERE type != 'Run' AND sport_type != 'Run'
          AND start_date_local >= ?
        ORDER BY start_date_local DESC
      `)
      .all(fourWeeksAgo.toISOString()) as Array<{
        name: string;
        type: string;
        sport_type: string;
        start_date_local: string;
        distance: number;
        moving_time: number;
      }>;

    if (crossTraining.length > 0) {
      md += `## Cross-Training (Last 4 Weeks)\n`;
      for (const act of crossTraining) {
        const date = new Date(act.start_date_local);
        const dateStr = date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
        const type = act.sport_type || act.type;
        const distKm = act.distance > 0 ? `${(act.distance / 1000).toFixed(1)}km` : "";
        const durationMin = Math.round(act.moving_time / 60);
        const durationStr = durationMin >= 60
          ? `${Math.floor(durationMin / 60)}h${durationMin % 60 > 0 ? `${durationMin % 60}min` : ""}`
          : `${durationMin}min`;
        md += `- ${dateStr}: ${type}${distKm ? ` — ${distKm}` : ""}, ${durationStr} — "${act.name}"\n`;
      }
      md += `\n`;
    }

    md += `## Quick Stats (Last 6 Months)\n`;
    md += `- Typical weekly volume: ${quickStats.typicalWeeklyVolume.min}-${quickStats.typicalWeeklyVolume.max}km\n`;
    md += `- Runs per week: Usually ${quickStats.runsPerWeek}\n`;
    if (quickStats.longRunDay) {
      md += `- Long run day: Usually ${quickStats.longRunDay}\n`;
    }

    await fs.mkdir(path.dirname(SUMMARY_FILE), { recursive: true });
    await fs.writeFile(SUMMARY_FILE, md);

    return md;
  } finally {
    db.close();
  }
}
