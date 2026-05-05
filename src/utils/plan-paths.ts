import * as fs from "fs/promises";
import * as path from "path";
import { getDataDir } from "./paths.js";

export function getPlansRoot(): string {
  return path.join(getDataDir(), "plans");
}

export function getPlanDir(slug: string): string {
  return path.join(getPlansRoot(), slug);
}

export function getPlanFile(slug: string): string {
  return path.join(getPlanDir(slug), "plan.md");
}

export function getChangelogFile(slug: string): string {
  return path.join(getPlanDir(slug), "CHANGELOG.md");
}

export function getDraftMarker(slug: string): string {
  return path.join(getPlanDir(slug), ".draft-active");
}

export function getDraftDir(slug: string, version: number): string {
  return path.join(getPlanDir(slug), "versions", `v${version}-draft`);
}

export function getDraftPlanFile(slug: string, version: number): string {
  return path.join(getDraftDir(slug, version), "plan.md");
}

export function getDraftReasoningFile(slug: string, version: number): string {
  return path.join(getDraftDir(slug, version), "reasoning.md");
}

export function getVersionDir(slug: string, version: number): string {
  return path.join(getPlanDir(slug), "versions", `v${version}`);
}

export function getVersionPlanFile(slug: string, version: number): string {
  return path.join(getVersionDir(slug, version), "plan.md");
}

export function getVersionReasoningFile(slug: string, version: number): string {
  return path.join(getVersionDir(slug, version), "reasoning.md");
}

export function getReferencesDir(slug: string): string {
  return path.join(getPlanDir(slug), "references");
}

export function getReferencesIndex(slug: string): string {
  return path.join(getReferencesDir(slug), "INDEX.md");
}

export function getResearchIndex(slug: string): string {
  return path.join(getPlanDir(slug), "research", "INDEX.md");
}

export function getExportsDir(slug: string): string {
  return path.join(getPlanDir(slug), "exports");
}

export async function isDraftActive(slug: string): Promise<boolean> {
  try {
    await fs.access(getDraftMarker(slug));
    return true;
  } catch {
    return false;
  }
}

export async function listPlanSlugs(): Promise<string[]> {
  let entries;
  try {
    entries = await fs.readdir(getPlansRoot(), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

/**
 * Highest existing version (ignoring drafts) plus one. Used when entering
 * revision mode to name the new draft directory.
 */
export async function nextDraftVersion(slug: string): Promise<number> {
  const versionsDir = path.join(getPlanDir(slug), "versions");
  let entries: string[];
  try {
    entries = await fs.readdir(versionsDir);
  } catch {
    return 1;
  }
  let max = 0;
  for (const e of entries) {
    // Strict match: only v1, v2, ... — ignores v2-draft and any other file/dir.
    const m = e.match(/^v(\d+)$/);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return max + 1;
}
