import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import {
  getPlansRoot,
  getPlanDir,
  getPlanFile,
  getChangelogFile,
  getDraftMarker,
  getDraftDir,
  getDraftPlanFile,
  getDraftReasoningFile,
  getVersionDir,
  getVersionPlanFile,
  getVersionReasoningFile,
  getReferencesDir,
  getReferencesIndex,
  getResearchIndex,
  getExportsDir,
  isDraftActive,
  listPlanSlugs,
  nextDraftVersion,
} from "../plan-paths.js";

let tmpDataDir: string;
let originalDataDir: string | undefined;

beforeEach(async () => {
  tmpDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "runnai-plan-paths-"));
  originalDataDir = process.env.RUNNAI_DATA_DIR;
  process.env.RUNNAI_DATA_DIR = tmpDataDir;
});

afterEach(async () => {
  if (originalDataDir === undefined) delete process.env.RUNNAI_DATA_DIR;
  else process.env.RUNNAI_DATA_DIR = originalDataDir;
  await fs.rm(tmpDataDir, { recursive: true, force: true });
});

describe("plan-paths", () => {
  test("getPlansRoot is data/plans", () => {
    expect(getPlansRoot()).toBe(path.join(tmpDataDir, "plans"));
  });

  test("path helpers compose correctly", () => {
    const slug = "spring-2026-dual";
    const planDir = path.join(tmpDataDir, "plans", slug);
    expect(getPlanDir(slug)).toBe(planDir);
    expect(getPlanFile(slug)).toBe(path.join(planDir, "plan.md"));
    expect(getChangelogFile(slug)).toBe(path.join(planDir, "CHANGELOG.md"));
    expect(getDraftMarker(slug)).toBe(path.join(planDir, ".draft-active"));
    expect(getDraftDir(slug, 2)).toBe(path.join(planDir, "versions", "v2-draft"));
    expect(getDraftPlanFile(slug, 2)).toBe(path.join(planDir, "versions", "v2-draft", "plan.md"));
    expect(getDraftReasoningFile(slug, 2)).toBe(path.join(planDir, "versions", "v2-draft", "reasoning.md"));
    expect(getVersionDir(slug, 1)).toBe(path.join(planDir, "versions", "v1"));
    expect(getVersionPlanFile(slug, 1)).toBe(path.join(planDir, "versions", "v1", "plan.md"));
    expect(getVersionReasoningFile(slug, 1)).toBe(path.join(planDir, "versions", "v1", "reasoning.md"));
    expect(getReferencesDir(slug)).toBe(path.join(planDir, "references"));
    expect(getReferencesIndex(slug)).toBe(path.join(planDir, "references", "INDEX.md"));
    expect(getResearchIndex(slug)).toBe(path.join(planDir, "research", "INDEX.md"));
    expect(getExportsDir(slug)).toBe(path.join(planDir, "exports"));
  });

  test("isDraftActive returns false when no marker", async () => {
    await fs.mkdir(getPlanDir("plan-a"), { recursive: true });
    expect(await isDraftActive("plan-a")).toBe(false);
  });

  test("isDraftActive returns true when marker exists", async () => {
    await fs.mkdir(getPlanDir("plan-a"), { recursive: true });
    await fs.writeFile(getDraftMarker("plan-a"), "");
    expect(await isDraftActive("plan-a")).toBe(true);
  });

  test("listPlanSlugs returns directories only, sorted", async () => {
    await fs.mkdir(getPlanDir("zeta"), { recursive: true });
    await fs.mkdir(getPlanDir("alpha"), { recursive: true });
    // A stray file in plans/ — should be ignored
    await fs.writeFile(path.join(getPlansRoot(), "stray.txt"), "");
    const slugs = await listPlanSlugs();
    expect(slugs).toEqual(["alpha", "zeta"]);
  });

  test("listPlanSlugs returns [] when plans dir does not exist", async () => {
    const slugs = await listPlanSlugs();
    expect(slugs).toEqual([]);
  });

  test("nextDraftVersion returns 1 when no versions exist", async () => {
    await fs.mkdir(getPlanDir("p"), { recursive: true });
    expect(await nextDraftVersion("p")).toBe(1);
  });

  test("nextDraftVersion returns N+1 of highest existing version (ignoring drafts)", async () => {
    await fs.mkdir(path.join(getPlanDir("p"), "versions", "v1"), { recursive: true });
    await fs.mkdir(path.join(getPlanDir("p"), "versions", "v2"), { recursive: true });
    await fs.mkdir(path.join(getPlanDir("p"), "versions", "v3-draft"), { recursive: true });
    expect(await nextDraftVersion("p")).toBe(3);
  });
});
