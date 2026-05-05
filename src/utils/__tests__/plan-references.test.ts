import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import {
  attachReference,
  readReferencesIndex,
  setUsedInVersions,
} from "../plan-references.js";
import { getPlanDir, getReferencesDir, getReferencesIndex } from "../plan-paths.js";

let tmp: string;
let originalEnv: string | undefined;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "runnai-refs-"));
  originalEnv = process.env.RUNNAI_DATA_DIR;
  process.env.RUNNAI_DATA_DIR = tmp;
  await fs.mkdir(getPlanDir("p"), { recursive: true });
});
afterEach(async () => {
  if (originalEnv === undefined) delete process.env.RUNNAI_DATA_DIR;
  else process.env.RUNNAI_DATA_DIR = originalEnv;
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("plan-references", () => {
  test("attachReference copies file and writes INDEX entry", async () => {
    const srcPath = path.join(tmp, "input.pdf");
    await fs.writeFile(srcPath, "%PDF-fake");
    await attachReference("p", srcPath, "The threshold plan we based v1 on.");

    const dest = path.join(getReferencesDir("p"), "input.pdf");
    expect(await fs.readFile(dest, "utf-8")).toBe("%PDF-fake");

    const index = await readReferencesIndex("p");
    expect(index).toContain("# References");
    expect(index).toContain("## input.pdf");
    expect(index).toContain("Original location:");
    expect(index).toContain("Note: The threshold plan we based v1 on.");
    expect(index).toContain("Used in versions: (none yet)");
  });

  test("attachReference twice for same file replaces note (idempotent)", async () => {
    const srcPath = path.join(tmp, "input.pdf");
    await fs.writeFile(srcPath, "v1");
    await attachReference("p", srcPath, "first note");
    await fs.writeFile(srcPath, "v2");
    await attachReference("p", srcPath, "updated note");

    const index = await readReferencesIndex("p");
    expect(index).toContain("Note: updated note");
    expect(index).not.toContain("Note: first note");
    const matches = index.match(/^## input\.pdf$/gm) ?? [];
    expect(matches.length).toBe(1);

    const dest = path.join(getReferencesDir("p"), "input.pdf");
    expect(await fs.readFile(dest, "utf-8")).toBe("v2");
  });

  test("setUsedInVersions updates the line for a given basename", async () => {
    const srcPath = path.join(tmp, "input.pdf");
    await fs.writeFile(srcPath, "x");
    await attachReference("p", srcPath, "note");
    await setUsedInVersions("p", "input.pdf", ["v1", "v2"]);
    const index = await readReferencesIndex("p");
    expect(index).toContain("Used in versions: v1, v2");
  });

  test("setUsedInVersions on missing entry throws", async () => {
    await expect(setUsedInVersions("p", "missing.pdf", ["v1"])).rejects.toThrow();
  });
});
