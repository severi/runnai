export interface ParsedWorkout {
  weekNumber: number;
  sessionIndex: number;
  date: string; // "YYYY-MM-DDT00:00:00"
  sessionName: string;
  details: string;
  externalId: string;
}

const MONTH_MAP: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

function stripMarkdown(text: string): string {
  return text.replace(/\*+/g, "").replace(/_+/g, "").trim();
}

function isRestDay(session: string): boolean {
  return stripMarkdown(session).toLowerCase() === "rest";
}

function extractPlanYear(markdown: string): number {
  // Look for a 4-digit year in the header area (first 20 lines)
  const headerLines = markdown.split("\n").slice(0, 20);
  for (const line of headerLines) {
    const match = line.match(/\b(20\d{2})\b/);
    if (match) return parseInt(match[1], 10);
  }
  return new Date().getFullYear();
}

function resolveDate(dateStr: string, year: number): string | null {
  // Parse dates like "Mar 9", "Apr 19", "Jul 11"
  const trimmed = stripMarkdown(dateStr).trim();
  const match = trimmed.match(/^([A-Za-z]+)\s+(\d{1,2})$/);
  if (!match) return null;

  const monthIndex = MONTH_MAP[match[1].toLowerCase().slice(0, 3)];
  if (monthIndex === undefined) return null;

  const day = parseInt(match[2], 10);
  const d = new Date(year, monthIndex, day);
  if (isNaN(d.getTime())) return null;

  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}T00:00:00`;
}

function findColumnIndices(headerRow: string): { dateIdx: number; sessionIdx: number; detailsIdx: number } | null {
  const cols = headerRow.split("|").map((c) => c.trim().toLowerCase()).filter(Boolean);
  const dateIdx = cols.findIndex((c) => c === "date");
  const sessionIdx = cols.findIndex((c) => c === "session");
  const detailsIdx = cols.findIndex((c) => c === "details");

  if (dateIdx === -1 || sessionIdx === -1 || detailsIdx === -1) return null;
  return { dateIdx, sessionIdx, detailsIdx };
}

export function parsePlan(markdown: string, planSlug: string, weekFilter?: number[]): ParsedWorkout[] {
  const year = extractPlanYear(markdown);
  const lines = markdown.split("\n");
  const workouts: ParsedWorkout[] = [];

  let currentWeek: number | null = null;
  let columnIndices: { dateIdx: number; sessionIdx: number; detailsIdx: number } | null = null;
  let inTable = false;
  let skippedSeparator = false;
  let sessionCounter = 0;

  for (const line of lines) {
    // Detect week headers: "## Week 1: Build 1" or "## Week 14: Recovery + Jukola (...)"
    const weekMatch = line.match(/^##\s+Week\s+(\d+)\b/i);
    if (weekMatch) {
      currentWeek = parseInt(weekMatch[1], 10);
      columnIndices = null;
      inTable = false;
      skippedSeparator = false;
      sessionCounter = 0;
      continue;
    }

    // Skip weeks not in filter
    if (currentWeek === null) continue;
    if (weekFilter && !weekFilter.includes(currentWeek)) continue;

    // Detect table header row
    if (!inTable && line.includes("|") && !columnIndices) {
      const indices = findColumnIndices(line);
      if (indices) {
        columnIndices = indices;
        skippedSeparator = false;
        continue;
      }
    }

    // Skip separator row (|---|---|...)
    if (columnIndices && !skippedSeparator && line.match(/^\|[\s-|]+$/)) {
      skippedSeparator = true;
      inTable = true;
      continue;
    }

    // Parse data rows
    if (inTable && columnIndices && line.startsWith("|")) {
      const cells = line.split("|").map((c) => c.trim()).filter(Boolean);
      const session = cells[columnIndices.sessionIdx];
      const details = cells[columnIndices.detailsIdx];
      const dateCell = cells[columnIndices.dateIdx];

      if (!session || !dateCell) continue;

      if (isRestDay(session)) continue;

      const resolvedDate = resolveDate(dateCell, year);
      if (!resolvedDate) continue;

      workouts.push({
        weekNumber: currentWeek,
        sessionIndex: sessionCounter,
        date: resolvedDate,
        sessionName: stripMarkdown(session),
        details: stripMarkdown(details || ""),
        externalId: `runnai:${planSlug}:w${currentWeek}:s${sessionCounter}`,
      });
      sessionCounter++;
      continue;
    }

    // End of table when we hit a non-pipe line after being in a table
    if (inTable && !line.startsWith("|")) {
      inTable = false;
      columnIndices = null;
    }
  }

  return workouts;
}

export interface PlanWeekExcerpt {
  weekNumber: number;
  markdown: string;
}

export function extractPlanWeeks(markdown: string, weekNumbers: number[]): PlanWeekExcerpt[] {
  const lines = markdown.split("\n");
  const weekSet = new Set(weekNumbers);
  const results: PlanWeekExcerpt[] = [];

  let currentWeek: number | null = null;
  let currentLines: string[] = [];

  for (const line of lines) {
    const weekMatch = line.match(/^##\s+Week\s+(\d+)\b/i);
    if (weekMatch) {
      // Flush previous week if it was one we wanted
      if (currentWeek !== null && weekSet.has(currentWeek)) {
        results.push({ weekNumber: currentWeek, markdown: currentLines.join("\n").trim() });
      }
      currentWeek = parseInt(weekMatch[1], 10);
      currentLines = [line];
      continue;
    }

    // End of a week section: another ## heading that is NOT a Week header
    if (currentWeek !== null) {
      if (line.match(/^##\s/) && !line.match(/^##\s+Week\s+\d+/i)) {
        // Non-week ## heading — flush and reset
        if (weekSet.has(currentWeek)) {
          results.push({ weekNumber: currentWeek, markdown: currentLines.join("\n").trim() });
        }
        currentWeek = null;
        currentLines = [];
        continue;
      }
      currentLines.push(line);
    }
  }

  // Flush last week
  if (currentWeek !== null && weekSet.has(currentWeek)) {
    results.push({ weekNumber: currentWeek, markdown: currentLines.join("\n").trim() });
  }

  return results;
}
