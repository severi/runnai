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
