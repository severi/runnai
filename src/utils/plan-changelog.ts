import * as fs from "fs/promises";
import { getChangelogFile } from "./plan-paths.js";

export interface ChangelogEntry {
  date: string; // YYYY-MM-DD
  title: string;
  body: string;
}

const HEADER = "# Changelog\n\n";

export async function readChangelog(slug: string): Promise<string> {
  try {
    return await fs.readFile(getChangelogFile(slug), "utf-8");
  } catch {
    return "";
  }
}

export async function appendChangelogEntry(slug: string, entry: ChangelogEntry): Promise<void> {
  const filePath = getChangelogFile(slug);
  const existing = await readChangelog(slug);
  const newEntry = `## ${entry.date} — ${entry.title}\n${entry.body}\n`;
  const next =
    existing.length === 0
      ? `${HEADER}${newEntry}`
      : insertAfterHeader(existing, newEntry);
  await fs.writeFile(filePath, next);
}

function insertAfterHeader(existing: string, newEntry: string): string {
  if (existing.startsWith(HEADER)) {
    const rest = existing.slice(HEADER.length);
    return `${HEADER}${newEntry}\n${rest}`;
  }
  // No recognizable header — prepend a fresh one + entry, keep the body.
  return `${HEADER}${newEntry}\n${existing}`;
}
