import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { appendChangelogEntry, readChangelog } from "../plan-changelog.js";
import { getPlanDir, getChangelogFile } from "../plan-paths.js";

let tmp: string;
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "runnai-cl-"));
  process.env.RUNNAI_DATA_DIR = tmp;
  await fs.mkdir(getPlanDir("p"), { recursive: true });
});
afterEach(async () => {
  delete process.env.RUNNAI_DATA_DIR;
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("plan-changelog", () => {
  test("creates CHANGELOG with header on first append", async () => {
    await appendChangelogEntry("p", { date: "2026-05-05", title: "v1: created", body: "Initial plan." });
    const cl = await readChangelog("p");
    expect(cl).toBe(`# Changelog\n\n## 2026-05-05 — v1: created\nInitial plan.\n`);
  });

  test("prepends new entries above old ones", async () => {
    await appendChangelogEntry("p", { date: "2026-05-01", title: "first", body: "a" });
    await appendChangelogEntry("p", { date: "2026-05-05", title: "second", body: "b" });
    const cl = await readChangelog("p");
    const idxFirst = cl.indexOf("first");
    const idxSecond = cl.indexOf("second");
    expect(idxSecond).toBeLessThan(idxFirst);
    expect(idxSecond).toBeGreaterThan(0);
  });

  test("readChangelog returns empty string when file does not exist", async () => {
    expect(await readChangelog("p")).toBe("");
  });

  test("body can span multiple lines but is preserved verbatim", async () => {
    await appendChangelogEntry("p", { date: "2026-05-05", title: "t", body: "line one\nline two" });
    const cl = await readChangelog("p");
    expect(cl).toContain("line one\nline two");
  });
});
