import * as fs from "fs/promises";
import * as path from "path";
import { getReferencesDir, getReferencesIndex } from "./plan-paths.js";
import { toDateString } from "./format.js";

const HEADER = "# References\n\n";

export async function readReferencesIndex(slug: string): Promise<string> {
  try {
    return await fs.readFile(getReferencesIndex(slug), "utf-8");
  } catch {
    return "";
  }
}

export async function attachReference(
  slug: string,
  sourcePath: string,
  note: string,
): Promise<{ destPath: string; basename: string }> {
  await fs.mkdir(getReferencesDir(slug), { recursive: true });
  const basename = path.basename(sourcePath);
  const destPath = path.join(getReferencesDir(slug), basename);
  await fs.copyFile(sourcePath, destPath);

  const existing = await readReferencesIndex(slug);
  const priorVersions = parseUsedInVersions(existing, basename);

  await upsertEntry(slug, {
    basename,
    addedDate: toDateString(),
    originalLocation: sourcePath,
    note,
    usedInVersions: priorVersions.length > 0 ? priorVersions : undefined,
  });

  return { destPath, basename };
}

interface RefEntry {
  basename: string;
  addedDate: string;
  originalLocation: string;
  note: string;
  usedInVersions?: string[];
}

async function upsertEntry(slug: string, entry: RefEntry): Promise<void> {
  const existing = await readReferencesIndex(slug);
  const without = removeEntry(existing, entry.basename);
  const next = appendEntry(without, entry);
  await fs.writeFile(getReferencesIndex(slug), next);
}

function appendEntry(existing: string, entry: RefEntry): string {
  const usedLine =
    entry.usedInVersions && entry.usedInVersions.length > 0
      ? `Used in versions: ${entry.usedInVersions.join(", ")}`
      : "Used in versions: (none yet)";
  const block = `## ${entry.basename}
- Added: ${entry.addedDate}
- Original location: ${entry.originalLocation}
- Note: ${entry.note}
- ${usedLine}
`;
  if (existing.length === 0) return `${HEADER}${block}`;
  return `${existing.endsWith("\n") ? existing : existing + "\n"}${block}`;
}

function parseUsedInVersions(indexContent: string, basename: string): string[] {
  if (!indexContent) return [];
  const headingIdx = indexContent.indexOf(`## ${basename}`);
  if (headingIdx === -1) return [];
  const next = indexContent.indexOf("\n## ", headingIdx + 4);
  const block = indexContent.slice(headingIdx, next === -1 ? undefined : next);
  const m = block.match(/-\s+Used in versions:\s*(.+)/);
  if (!m) return [];
  const value = m[1].trim();
  if (value === "(none yet)") return [];
  return value.split(",").map((v) => v.trim()).filter(Boolean);
}

function removeEntry(existing: string, basename: string): string {
  if (!existing) return "";
  const lines = existing.split("\n");
  const out: string[] = [];
  let skipping = false;
  for (const line of lines) {
    if (line.startsWith("## ")) {
      skipping = line === `## ${basename}`;
    }
    if (!skipping) out.push(line);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n");
}

export async function setUsedInVersions(
  slug: string,
  basename: string,
  versions: string[],
): Promise<void> {
  const existing = await readReferencesIndex(slug);
  if (!existing.includes(`## ${basename}`)) {
    throw new Error(`reference not found in index: ${basename}`);
  }
  const lines = existing.split("\n");
  let inEntry = false;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith("## ")) inEntry = lines[i] === `## ${basename}`;
    if (inEntry && lines[i].startsWith("- Used in versions:")) {
      lines[i] = `- Used in versions: ${versions.length === 0 ? "(none yet)" : versions.join(", ")}`;
      break;
    }
  }
  await fs.writeFile(getReferencesIndex(slug), lines.join("\n"));
}
