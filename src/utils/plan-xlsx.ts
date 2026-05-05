import ExcelJS from "exceljs";
import { parsePlan } from "./plan-parser.js";
import { parseFrontmatter } from "./plan-frontmatter.js";

const SCHEDULE_COLUMNS = [
  { header: "week", key: "week", width: 6 },
  { header: "phase", key: "phase", width: 18 },
  { header: "week_focus", key: "week_focus", width: 40 },
  { header: "target_volume_km", key: "target_volume_km", width: 16 },
  { header: "date", key: "date", width: 12 },
  { header: "day", key: "day", width: 6 },
  { header: "session_type", key: "session_type", width: 18 },
  { header: "distance_km", key: "distance_km", width: 12 },
  { header: "intensity", key: "intensity", width: 18 },
  { header: "details", key: "details", width: 50 },
  { header: "status", key: "status", width: 12 },
  { header: "user_note", key: "user_note", width: 30 },
];

interface WeekMeta {
  number: number;
  phase: string;
  focus: string;
}

function extractWeekMeta(planMarkdown: string): Map<number, WeekMeta> {
  const out = new Map<number, WeekMeta>();
  const lines = planMarkdown.split("\n");
  let current: WeekMeta | null = null;
  for (const line of lines) {
    const m = line.match(/^##\s+Week\s+(\d+):\s*(.+?)\s*$/);
    if (m) {
      if (current) out.set(current.number, current);
      current = { number: parseInt(m[1], 10), phase: m[2].trim(), focus: "" };
      continue;
    }
    if (current) {
      const focusMatch = line.match(/^\*\*Key Focus:\*\*\s*(.+)$/);
      if (focusMatch) current.focus = focusMatch[1].trim();
    }
  }
  if (current) out.set(current.number, current);
  return out;
}

const DAY_BY_INDEX = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
function dayLabel(isoDate: string): string {
  const d = new Date(isoDate);
  return DAY_BY_INDEX[d.getDay()];
}

const DISTANCE_RX = /(\d+(?:\.\d+)?)\s*km/i;
function inferDistance(details: string): number | null {
  const m = details.match(DISTANCE_RX);
  return m ? parseFloat(m[1]) : null;
}

export async function exportPlanToXlsx(
  planMarkdown: string,
  slug: string,
  outPath: string,
): Promise<void> {
  const { body } = parseFrontmatter(planMarkdown);
  const planBody = body ?? planMarkdown;
  const workouts = parsePlan(planBody, slug);
  const weekMeta = extractWeekMeta(planBody);

  const wb = new ExcelJS.Workbook();
  wb.creator = "RunnAI";

  const sched = wb.addWorksheet("Schedule");
  sched.columns = SCHEDULE_COLUMNS;
  sched.views = [{ state: "frozen", ySplit: 1 }];

  const weekRowRanges = new Map<number, { start: number; end: number }>();
  let rowIdx = 2;
  for (const w of workouts) {
    const meta = weekMeta.get(w.weekNumber) ?? { number: w.weekNumber, phase: "", focus: "" };
    const distance = inferDistance(w.details);
    const isoDate = w.date.split("T")[0];

    sched.addRow({
      week: w.weekNumber,
      phase: meta.phase,
      week_focus: meta.focus,
      target_volume_km: null,
      date: isoDate,
      day: dayLabel(w.date),
      session_type: w.sessionName,
      distance_km: distance,
      intensity: "",
      details: w.details,
      status: "planned",
      user_note: "",
    });

    const range = weekRowRanges.get(w.weekNumber);
    if (!range) weekRowRanges.set(w.weekNumber, { start: rowIdx, end: rowIdx });
    else range.end = rowIdx;
    rowIdx++;
  }

  for (const [, range] of weekRowRanges) {
    for (let r = range.start; r <= range.end; r++) {
      const cell = sched.getCell(`D${r}`);
      cell.value = { formula: `SUM(H${range.start}:H${range.end})` } as any;
    }
  }

  const header = sched.getRow(1);
  header.font = { bold: true };

  const summary = wb.addWorksheet("Summary");
  summary.columns = [
    { header: "week", key: "week", width: 6 },
    { header: "phase", key: "phase", width: 18 },
    { header: "total_km", key: "total_km", width: 12 },
    { header: "long_run_km", key: "long_run_km", width: 12 },
  ];
  summary.views = [{ state: "frozen", ySplit: 1 }];

  for (const [weekNum, range] of [...weekRowRanges].sort((a, b) => a[0] - b[0])) {
    const meta = weekMeta.get(weekNum);
    const sumRow = summary.addRow({
      week: weekNum,
      phase: meta?.phase ?? "",
      total_km: null,
      long_run_km: null,
    });
    sumRow.getCell(3).value = { formula: `SUM(Schedule!H${range.start}:H${range.end})` } as any;
    sumRow.getCell(4).value = { formula: `MAX(Schedule!H${range.start}:H${range.end})` } as any;
  }
  summary.getRow(1).font = { bold: true };

  await wb.xlsx.writeFile(outPath);
}

export interface XlsxScheduleRow {
  week: number;
  phase: string;
  week_focus: string;
  date: string; // YYYY-MM-DD
  day: string;
  session_type: string;
  distance_km: number | null;
  intensity: string;
  details: string;
  status: string;
  user_note: string;
}

export async function parseXlsxSchedule(xlsxPath: string): Promise<XlsxScheduleRow[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(xlsxPath);
  const sheet = wb.getWorksheet("Schedule");
  if (!sheet) throw new Error(`Schedule sheet missing in ${xlsxPath}`);

  const header = sheet.getRow(1);
  const colIdx = new Map<string, number>();
  header.eachCell((cell, col) => {
    if (typeof cell.value === "string") colIdx.set(cell.value, col);
  });
  const required = ["week", "phase", "week_focus", "date", "day", "session_type", "distance_km", "intensity", "details", "status", "user_note"];
  for (const r of required) {
    if (!colIdx.has(r)) throw new Error(`xlsx missing required column: ${r}`);
  }

  const rows: XlsxScheduleRow[] = [];
  sheet.eachRow((row, rowNum) => {
    if (rowNum === 1) return;
    const get = (key: string) => row.getCell(colIdx.get(key)!).value;
    const distVal = get("distance_km");
    const dateVal = get("date");
    let dateStr = "";
    if (typeof dateVal === "string") {
      dateStr = dateVal;
    } else if (dateVal instanceof Date) {
      dateStr = dateVal.toISOString().slice(0, 10);
    }
    rows.push({
      week: Number(get("week")) || 0,
      phase: String(get("phase") ?? ""),
      week_focus: String(get("week_focus") ?? ""),
      date: dateStr,
      day: String(get("day") ?? ""),
      session_type: String(get("session_type") ?? ""),
      distance_km: typeof distVal === "number" ? distVal : (distVal && (distVal as any).result) || null,
      intensity: String(get("intensity") ?? ""),
      details: String(get("details") ?? ""),
      status: String(get("status") ?? ""),
      user_note: String(get("user_note") ?? ""),
    });
  });
  return rows;
}

export interface ScheduleChange {
  kind: "distance_changed" | "session_type_changed" | "details_changed" | "added" | "removed" | "status_changed";
  week: number;
  date: string;
  before?: string | number | null;
  after?: string | number | null;
}

export interface ScheduleNote {
  week: number;
  date: string;
  note: string;
}

export interface ScheduleDiff {
  changes: ScheduleChange[];
  notes: ScheduleNote[];
}

export function diffScheduleAgainstPlan(rows: XlsxScheduleRow[], planMarkdown: string): ScheduleDiff {
  const { body } = parseFrontmatter(planMarkdown);
  const planBody = body ?? planMarkdown;
  const workouts = parsePlan(planBody, "compare");
  const byKey = new Map<string, { distance: number | null; session: string; details: string }>();
  for (const w of workouts) {
    const key = `${w.weekNumber}|${w.date.slice(0, 10)}`;
    byKey.set(key, {
      distance: inferDistance(w.details),
      session: w.sessionName,
      details: w.details,
    });
  }

  const changes: ScheduleChange[] = [];
  const notes: ScheduleNote[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    const key = `${row.week}|${row.date}`;
    seen.add(key);
    const original = byKey.get(key);
    if (row.user_note.trim().length > 0) {
      notes.push({ week: row.week, date: row.date, note: row.user_note.trim() });
    }
    if (!original) {
      changes.push({ kind: "added", week: row.week, date: row.date });
      continue;
    }
    if (original.distance !== row.distance_km) {
      changes.push({ kind: "distance_changed", week: row.week, date: row.date, before: original.distance, after: row.distance_km });
    }
    if (original.session.toLowerCase() !== row.session_type.toLowerCase()) {
      changes.push({ kind: "session_type_changed", week: row.week, date: row.date, before: original.session, after: row.session_type });
    }
    if (original.details !== row.details) {
      changes.push({ kind: "details_changed", week: row.week, date: row.date, before: original.details, after: row.details });
    }
    if (row.status !== "planned") {
      changes.push({ kind: "status_changed", week: row.week, date: row.date, after: row.status });
    }
  }

  for (const [key] of byKey) {
    if (!seen.has(key)) {
      const [w, d] = key.split("|");
      changes.push({ kind: "removed", week: parseInt(w, 10), date: d });
    }
  }

  return { changes, notes };
}
