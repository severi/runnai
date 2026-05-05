export interface RenderDiffOptions {
  mode: "summary" | "unified";
}

export function renderDiff(currentText: string, draftText: string, opts: RenderDiffOptions): string {
  if (currentText === draftText) return "_No changes detected._";
  if (opts.mode === "unified") return renderUnified(currentText, draftText);
  return renderSummary(currentText, draftText);
}

function renderUnified(a: string, b: string): string {
  const aLines = a.split("\n");
  const bLines = b.split("\n");
  const out: string[] = ["```diff"];
  const maxLen = Math.max(aLines.length, bLines.length);
  for (let i = 0; i < maxLen; i++) {
    const av = aLines[i];
    const bv = bLines[i];
    if (av === bv) {
      if (av !== undefined) out.push(`  ${av}`);
    } else {
      if (av !== undefined) out.push(`- ${av}`);
      if (bv !== undefined) out.push(`+ ${bv}`);
    }
  }
  out.push("```");
  return out.join("\n");
}

interface WeekBlock {
  number: number;
  heading: string;
  body: string;
}

function splitByWeek(text: string): WeekBlock[] {
  const lines = text.split("\n");
  const blocks: WeekBlock[] = [];
  let current: WeekBlock | null = null;
  for (const line of lines) {
    const m = line.match(/^##\s+Week\s+(\d+)/);
    if (m) {
      if (current) blocks.push(current);
      current = { number: parseInt(m[1], 10), heading: line, body: "" };
    } else if (current) {
      current.body += line + "\n";
    }
  }
  if (current) blocks.push(current);
  return blocks;
}

function renderSummary(currentText: string, draftText: string): string {
  const currentWeeks = splitByWeek(currentText);
  const draftWeeks = splitByWeek(draftText);
  const map = new Map<number, { current?: WeekBlock; draft?: WeekBlock }>();
  for (const w of currentWeeks) map.set(w.number, { current: w });
  for (const w of draftWeeks) {
    const e = map.get(w.number) ?? {};
    e.draft = w;
    map.set(w.number, e);
  }
  const changed: number[] = [];
  for (const [num, entry] of map) {
    const a = entry.current?.body ?? "";
    const b = entry.draft?.body ?? "";
    if (a !== b) changed.push(num);
  }
  if (changed.length === 0) return "_No changes detected._";

  const lines: string[] = [];
  lines.push(`# Diff: current vs draft\n\nChanged weeks: ${changed.sort((a, b) => a - b).join(", ")}\n`);
  for (const num of changed.sort((a, b) => a - b)) {
    const entry = map.get(num)!;
    lines.push(`## Week ${num}\n`);
    if (!entry.current) {
      lines.push(`_New week added in draft._\n\n${entry.draft!.heading}\n${entry.draft!.body}`);
    } else if (!entry.draft) {
      lines.push(`_Week removed in draft._\n\n${entry.current.heading}\n${entry.current.body}`);
    } else {
      lines.push("**Current:**\n");
      lines.push("```");
      lines.push(entry.current.body.trim());
      lines.push("```");
      lines.push("\n**Draft:**\n");
      lines.push("```");
      lines.push(entry.draft.body.trim());
      lines.push("```\n");
    }
  }
  return lines.join("\n");
}
