import * as fs from "fs/promises";
import * as path from "path";
import { getResearchIndex, getPlanDir } from "./plan-paths.js";
import { toDateString } from "./format.js";

const HEADER = "# Research used in this plan\n\n";

export async function readResearchIndex(slug: string): Promise<string> {
  try {
    return await fs.readFile(getResearchIndex(slug), "utf-8");
  } catch {
    return "";
  }
}

export async function linkResearch(
  slug: string,
  researchFilename: string,
  note: string,
): Promise<void> {
  await fs.mkdir(path.join(getPlanDir(slug), "research"), { recursive: true });
  const existing = await readResearchIndex(slug);
  const priorVersions = parseUsedInVersions(existing, researchFilename);
  const without = removeEntry(existing, researchFilename);
  const usedLine =
    priorVersions.length > 0
      ? `Used in versions: ${priorVersions.join(", ")}`
      : "Used in versions: (none yet)";
  const block = `## ${researchFilename}
- Linked: ${toDateString()}
- Note: ${note}
- ${usedLine}
`;
  const next =
    without.length === 0
      ? `${HEADER}${block}`
      : `${without.endsWith("\n") ? without : without + "\n"}${block}`;
  await fs.writeFile(getResearchIndex(slug), next);
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
    if (line.startsWith("## ")) skipping = line === `## ${basename}`;
    if (!skipping) out.push(line);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n");
}

export async function setUsedInVersions(
  slug: string,
  basename: string,
  versions: string[],
): Promise<void> {
  const existing = await readResearchIndex(slug);
  if (!existing.includes(`## ${basename}`)) {
    throw new Error(`research entry not found in index: ${basename}`);
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
  await fs.writeFile(getResearchIndex(slug), lines.join("\n"));
}
