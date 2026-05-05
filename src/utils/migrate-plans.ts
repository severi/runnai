import * as fs from "fs/promises";
import * as path from "path";
import {
  getPlansRoot,
  getPlanDir,
  getPlanFile,
  getVersionPlanFile,
  getVersionReasoningFile,
  getReferencesIndex,
  getResearchIndex,
} from "./plan-paths.js";
import { writeFrontmatter } from "./plan-frontmatter.js";
import { appendChangelogEntry } from "./plan-changelog.js";
import { toDateString } from "./format.js";

export interface MigrationResult {
  migrated: string[];
  skipped: string[];
}

export async function migratePlans(): Promise<MigrationResult> {
  const root = getPlansRoot();
  let entries: string[];
  try {
    entries = await fs.readdir(root);
  } catch {
    return { migrated: [], skipped: [] };
  }

  const migrated: string[] = [];
  const skipped: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(root, entry);
    const stat = await fs.stat(fullPath);

    if (stat.isFile() && entry.endsWith(".md")) {
      const slug = entry.replace(/\.md$/, "");
      const destDir = getPlanDir(slug);
      const destExists = await fs
        .stat(destDir)
        .then(() => true)
        .catch(() => false);
      if (destExists) {
        skipped.push(slug);
        continue;
      }
      await migrateOne(slug, fullPath);
      migrated.push(slug);
    } else if (stat.isDirectory()) {
      skipped.push(entry);
    }
  }

  return { migrated, skipped };
}

async function migrateOne(slug: string, oldPath: string): Promise<void> {
  const original = await fs.readFile(oldPath, "utf-8");
  const title = extractTitle(original) ?? slug;

  const planDir = getPlanDir(slug);
  await fs.mkdir(planDir, { recursive: true });
  await fs.mkdir(path.dirname(getVersionPlanFile(slug, 1)), { recursive: true });
  await fs.mkdir(path.dirname(getReferencesIndex(slug)), { recursive: true });
  await fs.mkdir(path.dirname(getResearchIndex(slug)), { recursive: true });

  const liveContent = writeFrontmatter(
    { title, slug, created: toDateString() },
    original,
  );
  await fs.writeFile(getPlanFile(slug), liveContent);

  await fs.writeFile(getVersionPlanFile(slug, 1), liveContent);

  const reasoning = `# v1

## Trigger
Migrated from pre-versioning era. Original plan created prior to ${toDateString()}.

## Sources consulted
_See git history of data/plans/${slug}.md for change context prior to migration._

## Constraints

## Decisions and rationale
_See git history for change context prior to migration._

## Key changes from previous version
_Pre-versioning era — no previous version._

## Open items at finalize
_Pre-existing open items, if any, are documented in plan.md itself._
`;
  await fs.writeFile(getVersionReasoningFile(slug, 1), reasoning);

  await fs.writeFile(getReferencesIndex(slug), "# References\n\n");
  await fs.writeFile(getResearchIndex(slug), "# Research used in this plan\n\n");

  await appendChangelogEntry(slug, {
    date: toDateString(),
    title: "v1: Migrated to versioned layout",
    body: "Converted from single-file plan to directory layout.",
  });

  await fs.unlink(oldPath);
}

function extractTitle(markdown: string): string | null {
  for (const line of markdown.split("\n")) {
    const m = line.match(/^#\s+(.+?)\s*$/);
    if (m) return m[1];
  }
  return null;
}
