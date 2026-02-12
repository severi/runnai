import * as fs from "fs/promises";
import * as path from "path";
import { initDatabase } from "./activities-db.js";
import { getDataDir } from "./paths.js";

function getPatternsFile(): string {
  return path.join(getDataDir(), "memory/training-patterns.md");
}

interface WeekRow {
  week_start: string;
  total_runs: number;
  total_distance: number;
  easy_count: number;
  tempo_count: number;
  threshold_count: number;
  intervals_count: number;
  fartlek_count: number;
  long_run_count: number;
  race_count: number;
  recovery_count: number;
  progression_count: number;
  unknown_count: number;
  key_workouts: string | null;
}

export async function generateTrainingPatterns(): Promise<void> {
  const db = initDatabase();

  try {
    // Get weekly breakdown for the last 8 weeks
    const weeks = db.prepare(`
      SELECT
        date(start_date_local, 'weekday 0', '-6 days') as week_start,
        COUNT(*) as total_runs,
        SUM(distance) / 1000.0 as total_distance,
        SUM(CASE WHEN run_type = 'easy' THEN 1 ELSE 0 END) as easy_count,
        SUM(CASE WHEN run_type = 'tempo' THEN 1 ELSE 0 END) as tempo_count,
        SUM(CASE WHEN run_type = 'threshold' THEN 1 ELSE 0 END) as threshold_count,
        SUM(CASE WHEN run_type = 'intervals' THEN 1 ELSE 0 END) as intervals_count,
        SUM(CASE WHEN run_type = 'fartlek' THEN 1 ELSE 0 END) as fartlek_count,
        SUM(CASE WHEN run_type = 'long_run' THEN 1 ELSE 0 END) as long_run_count,
        SUM(CASE WHEN run_type = 'race' THEN 1 ELSE 0 END) as race_count,
        SUM(CASE WHEN run_type = 'recovery' THEN 1 ELSE 0 END) as recovery_count,
        SUM(CASE WHEN run_type = 'progression' THEN 1 ELSE 0 END) as progression_count,
        SUM(CASE WHEN run_type = 'unknown' OR run_type IS NULL THEN 1 ELSE 0 END) as unknown_count,
        GROUP_CONCAT(
          CASE WHEN run_type IN ('intervals', 'fartlek', 'tempo', 'threshold', 'progression', 'race')
            THEN run_type || COALESCE(' (' || run_type_detail || ')', '')
            ELSE NULL
          END, ', '
        ) as key_workouts
      FROM activities
      WHERE type = 'Run' AND trainer = 0
        AND start_date_local >= date('now', '-56 days')
      GROUP BY week_start
      ORDER BY week_start DESC
    `).all() as WeekRow[];

    // Get overall intensity distribution
    const totals = db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN run_type IN ('easy', 'recovery') THEN 1 ELSE 0 END) as easy_recovery,
        SUM(CASE WHEN run_type IN ('tempo', 'threshold') THEN 1 ELSE 0 END) as tempo_threshold,
        SUM(CASE WHEN run_type IN ('intervals', 'fartlek') THEN 1 ELSE 0 END) as intervals_fartlek,
        SUM(CASE WHEN run_type = 'long_run' THEN 1 ELSE 0 END) as long_runs,
        SUM(CASE WHEN run_type = 'progression' THEN 1 ELSE 0 END) as progressions,
        SUM(CASE WHEN run_type = 'race' THEN 1 ELSE 0 END) as races
      FROM activities
      WHERE type = 'Run' AND trainer = 0
        AND start_date_local >= date('now', '-56 days')
        AND run_type IS NOT NULL
    `).get() as {
      total: number;
      easy_recovery: number;
      tempo_threshold: number;
      intervals_fartlek: number;
      long_runs: number;
      progressions: number;
      races: number;
    };

    let md = `# Training Patterns\nLast updated: ${new Date().toISOString().split("T")[0]}\n\n`;

    // Weekly structure table
    md += `## Weekly Structure (Last 8 Weeks)\n`;
    md += `| Week | Runs | Easy | Tempo/Thr | Intervals | Long | km | Key Workouts |\n`;
    md += `|------|------|------|-----------|-----------|------|----|-------------|\n`;

    for (const w of weeks) {
      const weekLabel = formatWeekLabel(w.week_start);
      const easyTotal = w.easy_count + w.recovery_count;
      const tempoTotal = w.tempo_count + w.threshold_count;
      const intTotal = w.intervals_count + w.fartlek_count;
      md += `| ${weekLabel} | ${w.total_runs} | ${easyTotal} | ${tempoTotal} | ${intTotal} | ${w.long_run_count} | ${Math.round(w.total_distance)} | ${w.key_workouts || "-"} |\n`;
    }

    md += `\n`;

    // Intensity distribution
    if (totals && totals.total > 0) {
      md += `## Intensity Distribution (Last 8 Weeks)\n`;
      const pct = (n: number) => `${Math.round((n / totals.total) * 100)}%`;
      md += `- Easy/Recovery: ${pct(totals.easy_recovery)} (${totals.easy_recovery}/${totals.total})\n`;
      md += `- Tempo/Threshold: ${pct(totals.tempo_threshold)} (${totals.tempo_threshold}/${totals.total})\n`;
      md += `- Intervals/Fartlek: ${pct(totals.intervals_fartlek)} (${totals.intervals_fartlek}/${totals.total})\n`;
      md += `- Long Runs: ${pct(totals.long_runs)} (${totals.long_runs}/${totals.total})\n`;
      if (totals.progressions > 0) {
        md += `- Progression: ${pct(totals.progressions)} (${totals.progressions}/${totals.total})\n`;
      }
      if (totals.races > 0) {
        md += `- Races: ${pct(totals.races)} (${totals.races}/${totals.total})\n`;
      }
    }

    // Typical week pattern detection
    md += generateTypicalWeek(db, weeks);

    const patternsFile = getPatternsFile();
    await fs.mkdir(path.dirname(patternsFile), { recursive: true });
    await fs.writeFile(patternsFile, md);
  } finally {
    db.close();
  }
}

interface SlotRow {
  week_start: string;
  short_easy: number;
  medium_easy: number;
  long_runs: number;
  quality: number;
}

interface DowRow {
  dow: number;
  run_type: string;
  count: number;
  avg_km: number;
}

const DOW_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function generateTypicalWeek(db: ReturnType<typeof initDatabase>, weeks: WeekRow[]): string {
  if (weeks.length < 3) return "";

  // Runs/week stats
  const runCounts = weeks.map(w => w.total_runs);
  const modeRuns = mode(runCounts);
  const minRuns = Math.min(...runCounts);
  const maxRuns = Math.max(...runCounts);

  // Distance slot distribution per week
  const slots = db.prepare(`
    SELECT
      date(start_date_local, 'weekday 0', '-6 days') as week_start,
      SUM(CASE WHEN distance < 10000 AND run_type IN ('easy', 'recovery', 'unknown') THEN 1 ELSE 0 END) as short_easy,
      SUM(CASE WHEN distance BETWEEN 10000 AND 15000 AND run_type IN ('easy', 'long_run', 'unknown') THEN 1 ELSE 0 END) as medium_easy,
      SUM(CASE WHEN distance > 15000 OR run_type = 'long_run' THEN 1 ELSE 0 END) as long_runs,
      SUM(CASE WHEN run_type IN ('tempo', 'threshold', 'intervals', 'fartlek', 'progression') THEN 1 ELSE 0 END) as quality
    FROM activities
    WHERE type = 'Run' AND trainer = 0
      AND start_date_local >= date('now', '-56 days')
    GROUP BY week_start
  `).all() as SlotRow[];

  const avgSlot = (key: keyof Omit<SlotRow, "week_start">) => {
    const vals = slots.map(s => s[key] as number);
    return Math.round(vals.reduce((a, b) => a + b, 0) / vals.length * 10) / 10;
  };

  // Day-of-week patterns
  const dowRows = db.prepare(`
    SELECT
      CAST(strftime('%w', start_date_local) AS INTEGER) as dow,
      run_type,
      COUNT(*) as count,
      AVG(distance) / 1000.0 as avg_km
    FROM activities
    WHERE type = 'Run' AND trainer = 0
      AND start_date_local >= date('now', '-56 days')
    GROUP BY dow, run_type
    ORDER BY dow
  `).all() as DowRow[];

  // Aggregate by day: total runs and dominant type
  const dowTotals: Record<number, { total: number; types: Record<string, number>; avgKm: number }> = {};
  for (const row of dowRows) {
    if (!dowTotals[row.dow]) dowTotals[row.dow] = { total: 0, types: {}, avgKm: 0 };
    dowTotals[row.dow].total += row.count;
    dowTotals[row.dow].types[row.run_type] = (dowTotals[row.dow].types[row.run_type] || 0) + row.count;
    dowTotals[row.dow].avgKm += row.avg_km * row.count;
  }
  for (const d of Object.values(dowTotals)) {
    d.avgKm = d.total > 0 ? d.avgKm / d.total : 0;
  }

  // Find long run day and quality day(s)
  let longRunDay = "";
  let qualityDays: string[] = [];
  const restDays: string[] = [];
  const runDays: string[] = [];

  for (let d = 0; d < 7; d++) {
    const info = dowTotals[d];
    if (!info || info.total < 2) {
      restDays.push(DOW_NAMES[d]);
      continue;
    }
    runDays.push(DOW_NAMES[d]);

    const types = info.types;
    if ((types["long_run"] || 0) >= 2) {
      longRunDay = `${DOW_NAMES[d]} (${types["long_run"]}/${weeks.length} weeks)`;
    }
    const qualityCount = (types["tempo"] || 0) + (types["threshold"] || 0) +
      (types["intervals"] || 0) + (types["fartlek"] || 0) + (types["progression"] || 0);
    if (qualityCount >= 2) {
      qualityDays.push(DOW_NAMES[d]);
    }
  }

  // Quality session type breakdown
  const qualityTypes = db.prepare(`
    SELECT run_type, COUNT(*) as count
    FROM activities
    WHERE type = 'Run' AND trainer = 0
      AND start_date_local >= date('now', '-56 days')
      AND run_type IN ('tempo', 'threshold', 'intervals', 'fartlek', 'progression')
    GROUP BY run_type
    ORDER BY count DESC
  `).all() as { run_type: string; count: number }[];

  const totalQuality = qualityTypes.reduce((s, r) => s + r.count, 0);

  let md = `\n## Typical Week Pattern\n`;
  md += `- Runs/week: ${modeRuns} (range: ${minRuns}-${maxRuns})\n`;

  // Slot structure
  const slotParts: string[] = [];
  const se = avgSlot("short_easy");
  const me = avgSlot("medium_easy");
  const lr = avgSlot("long_runs");
  const q = avgSlot("quality");
  if (se >= 0.5) slotParts.push(`${roundSlot(se)} short easy (<10km)`);
  if (me >= 0.5) slotParts.push(`${roundSlot(me)} medium easy (10-15km)`);
  if (q >= 0.5) slotParts.push(`${roundSlot(q)} quality session${q >= 1.5 ? "s" : ""}`);
  if (lr >= 0.5) slotParts.push(`${roundSlot(lr)} long run${lr >= 1.5 ? "s" : ""} (>15km)`);
  if (slotParts.length > 0) {
    md += `- Structure: ${slotParts.join(", ")}\n`;
  }

  // Quality breakdown
  if (totalQuality > 0) {
    const parts = qualityTypes.map(r =>
      `${r.run_type} ${Math.round((r.count / totalQuality) * 100)}%`
    );
    md += `- Quality sessions: ${parts.join(", ")}\n`;
  }

  // Day patterns
  if (longRunDay) md += `- Long run day: ${longRunDay}\n`;
  if (qualityDays.length > 0) md += `- Quality day${qualityDays.length > 1 ? "s" : ""}: ${qualityDays.join(", ")}\n`;
  if (runDays.length > 0) md += `- Run days: ${runDays.join(", ")}\n`;
  if (restDays.length > 0) md += `- Rest days: ${restDays.join(", ")}\n`;

  return md;
}

function mode(values: number[]): number {
  const counts = new Map<number, number>();
  for (const v of values) counts.set(v, (counts.get(v) || 0) + 1);
  let best = values[0];
  let bestCount = 0;
  for (const [v, c] of counts) {
    if (c > bestCount) { best = v; bestCount = c; }
  }
  return best;
}

function roundSlot(avg: number): string {
  const r = Math.round(avg);
  return r === avg ? `${r}` : `~${r}`;
}

function formatWeekLabel(weekStart: string): string {
  const date = new Date(weekStart + "T00:00:00");
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
