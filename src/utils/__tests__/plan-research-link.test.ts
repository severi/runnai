import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import {
  linkResearch,
  readResearchIndex,
  setUsedInVersions,
} from "../plan-research-link.js";
import { getPlanDir } from "../plan-paths.js";

let tmp: string;
let originalEnv: string | undefined;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "runnai-rl-"));
  originalEnv = process.env.RUNNAI_DATA_DIR;
  process.env.RUNNAI_DATA_DIR = tmp;
  await fs.mkdir(getPlanDir("p"), { recursive: true });
});
afterEach(async () => {
  if (originalEnv === undefined) delete process.env.RUNNAI_DATA_DIR;
  else process.env.RUNNAI_DATA_DIR = originalEnv;
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("plan-research-link", () => {
  test("linkResearch creates INDEX entry without copying file", async () => {
    await linkResearch("p", "100km-ultra-training.md", "Justified dropping speedwork.");
    const index = await readResearchIndex("p");
    expect(index).toContain("# Research used in this plan");
    expect(index).toContain("## 100km-ultra-training.md");
    expect(index).toContain("Note: Justified dropping speedwork.");
    expect(index).toContain("Used in versions: (none yet)");
    const planDir = getPlanDir("p");
    const researchSubdir = path.join(planDir, "research");
    const entries = await fs.readdir(researchSubdir);
    expect(entries).toEqual(["INDEX.md"]);
  });

  test("linkResearch is idempotent — second call replaces note", async () => {
    await linkResearch("p", "topic.md", "first");
    await linkResearch("p", "topic.md", "second");
    const index = await readResearchIndex("p");
    const matches = index.match(/^## topic\.md$/gm) ?? [];
    expect(matches.length).toBe(1);
    expect(index).toContain("Note: second");
    expect(index).not.toContain("Note: first");
  });

  test("setUsedInVersions updates entry", async () => {
    await linkResearch("p", "topic.md", "n");
    await setUsedInVersions("p", "topic.md", ["v1"]);
    const index = await readResearchIndex("p");
    expect(index).toContain("Used in versions: v1");
  });

  test("linkResearch preserves existing Used in versions when re-linking", async () => {
    await linkResearch("p", "topic.md", "first");
    await setUsedInVersions("p", "topic.md", ["v1"]);
    await linkResearch("p", "topic.md", "second");
    const index = await readResearchIndex("p");
    expect(index).toContain("Used in versions: v1");
    expect(index).toContain("Note: second");
  });
});
