import * as fs from "fs/promises";
import * as path from "path";
import {
  getPlanFile,
  getDraftMarker,
  getDraftDir,
  getDraftPlanFile,
  getDraftReasoningFile,
  getVersionDir,
  getVersionPlanFile,
  getVersionReasoningFile,
  isDraftActive,
  nextDraftVersion,
} from "./plan-paths.js";
import { initReasoning, checkRequiredSectionsFilled } from "./plan-reasoning.js";
import { appendChangelogEntry } from "./plan-changelog.js";
import { setUsedInVersions as setRefVersions, readReferencesIndex } from "./plan-references.js";
import { setUsedInVersions as setResearchVersions, readResearchIndex } from "./plan-research-link.js";
import { toDateString } from "./format.js";

export interface BeginRevisionResult {
  draftVersion: number;
}

export async function beginRevision(slug: string): Promise<BeginRevisionResult> {
  if (await isDraftActive(slug)) {
    throw new Error(`already have an active draft for ${slug}; finalize or discard first`);
  }
  const version = await nextDraftVersion(slug);
  await fs.mkdir(getDraftDir(slug, version), { recursive: true });

  const liveContent = await fs.readFile(getPlanFile(slug), "utf-8");
  await fs.writeFile(getDraftPlanFile(slug, version), liveContent);
  await initReasoning(getDraftReasoningFile(slug, version), { version });
  await fs.writeFile(getDraftMarker(slug), "");

  return { draftVersion: version };
}

export interface FinalizeOptions {
  allowEmpty?: boolean;
  changelogTitle?: string;
  changelogBody?: string;
}

export interface FinalizeResult {
  version: number;
  warnings: string[];
}

export async function finalizeRevision(slug: string, opts: FinalizeOptions = {}): Promise<FinalizeResult> {
  if (!(await isDraftActive(slug))) {
    throw new Error(`no active draft for ${slug}`);
  }
  const version = await nextDraftVersion(slug);
  const draftDir = getDraftDir(slug, version);
  const draftReasoning = getDraftReasoningFile(slug, version);

  const empty = await checkRequiredSectionsFilled(draftReasoning);
  const warnings: string[] = empty.map((s) => `required reasoning section is empty: ${s}`);
  if (warnings.length > 0 && !opts.allowEmpty) {
    throw new Error(`required sections empty in reasoning.md: ${empty.join(", ")} (pass allowEmpty:true to override)`);
  }

  // Move draft → v{version}
  const finalDir = getVersionDir(slug, version);
  await fs.rename(draftDir, finalDir);

  // Swap live plan ← versioned snapshot
  const finalPlan = await fs.readFile(getVersionPlanFile(slug, version), "utf-8");
  await fs.writeFile(getPlanFile(slug), finalPlan);

  // Remove marker
  await fs.unlink(getDraftMarker(slug));

  // Update Used-in-versions for cited refs/research
  const reasoning = await fs.readFile(getVersionReasoningFile(slug, version), "utf-8");
  const cited = parseSourcesConsulted(reasoning);
  await updateUsedInVersions(slug, cited, `v${version}`);

  // CHANGELOG entry
  const title = opts.changelogTitle ?? `v${version}: revision finalized`;
  const body = opts.changelogBody ?? `See versions/v${version}/reasoning.md.`;
  await appendChangelogEntry(slug, { date: toDateString(), title, body });

  return { version, warnings };
}

export async function discardRevision(slug: string): Promise<void> {
  if (!(await isDraftActive(slug))) return;
  const version = await nextDraftVersion(slug);
  await fs.rm(getDraftDir(slug, version), { recursive: true, force: true });
  try {
    await fs.unlink(getDraftMarker(slug));
  } catch {
    // ignore missing marker
  }
}

function parseSourcesConsulted(reasoning: string): { references: string[]; research: string[] } {
  const headingIdx = reasoning.indexOf("## Sources consulted");
  if (headingIdx === -1) return { references: [], research: [] };
  const next = reasoning.indexOf("\n## ", headingIdx + 4);
  const block = reasoning.slice(headingIdx, next === -1 ? undefined : next);
  const references: string[] = [];
  const research: string[] = [];
  for (const line of block.split("\n")) {
    const refMatch = line.match(/-\s+references\/([^\s—]+)/);
    if (refMatch) references.push(refMatch[1]);
    const resMatch = line.match(/-\s+research\/([^\s—]+)/);
    if (resMatch) research.push(resMatch[1]);
  }
  return { references, research };
}

async function updateUsedInVersions(
  slug: string,
  cited: { references: string[]; research: string[] },
  versionLabel: string,
): Promise<void> {
  if (cited.references.length > 0) {
    const refsIdx = await readReferencesIndex(slug);
    for (const basename of cited.references) {
      const current = parseUsedInVersions(refsIdx, basename);
      if (!current.includes(versionLabel)) current.push(versionLabel);
      await setRefVersions(slug, basename, current);
    }
  }
  if (cited.research.length > 0) {
    const resIdx = await readResearchIndex(slug);
    for (const basename of cited.research) {
      const current = parseUsedInVersions(resIdx, basename);
      if (!current.includes(versionLabel)) current.push(versionLabel);
      await setResearchVersions(slug, basename, current);
    }
  }
}

function parseUsedInVersions(indexContent: string, basename: string): string[] {
  const headingIdx = indexContent.indexOf(`## ${basename}`);
  if (headingIdx === -1) return [];
  const nextHeading = indexContent.indexOf("\n## ", headingIdx + 4);
  const block = indexContent.slice(headingIdx, nextHeading === -1 ? indexContent.length : nextHeading);
  const m = block.match(/-\s+Used in versions:\s*(.+)/);
  if (!m) return [];
  const value = m[1].trim();
  if (value === "(none yet)") return [];
  return value.split(",").map((v) => v.trim()).filter(Boolean);
}
