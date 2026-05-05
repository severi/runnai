import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import {
  initReasoning,
  appendToSection,
  readReasoning,
  REASONING_SECTIONS,
  type ReasoningSection,
  checkRequiredSectionsFilled,
} from "../plan-reasoning.js";

let tmp: string;
const TEST_FILE = "reasoning-test.md";

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "runnai-rs-"));
});
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("plan-reasoning", () => {
  test("initReasoning writes a template with six sections", async () => {
    const filePath = path.join(tmp, TEST_FILE);
    await initReasoning(filePath, { version: 2 });
    const content = await readReasoning(filePath);
    for (const section of REASONING_SECTIONS) {
      expect(content).toContain(`## ${section}`);
    }
    expect(content).toContain("# v2");
  });

  test("appendToSection adds bullet under correct section", async () => {
    const filePath = path.join(tmp, TEST_FILE);
    await initReasoning(filePath, { version: 2 });
    await appendToSection(filePath, "Sources consulted", "- references/foo.pdf — bar");
    const content = await readReasoning(filePath);
    const idxSources = content.indexOf("## Sources consulted");
    const idxConstraints = content.indexOf("## Constraints");
    const idxBullet = content.indexOf("references/foo.pdf");
    expect(idxBullet).toBeGreaterThan(idxSources);
    expect(idxBullet).toBeLessThan(idxConstraints);
  });

  test("appendToSection preserves prior entries", async () => {
    const filePath = path.join(tmp, TEST_FILE);
    await initReasoning(filePath, { version: 2 });
    await appendToSection(filePath, "Constraints", "- bachelor party May 29-31");
    await appendToSection(filePath, "Constraints", "- Juhannus conflict Jun 19-20");
    const content = await readReasoning(filePath);
    expect(content).toContain("bachelor party");
    expect(content).toContain("Juhannus conflict");
  });

  test("appendToSection rejects unknown sections", async () => {
    const filePath = path.join(tmp, TEST_FILE);
    await initReasoning(filePath, { version: 2 });
    await expect(
      appendToSection(filePath, "Bogus" as ReasoningSection, "x"),
    ).rejects.toThrow();
  });

  test("checkRequiredSectionsFilled flags empty load-bearing sections", async () => {
    const filePath = path.join(tmp, TEST_FILE);
    await initReasoning(filePath, { version: 2 });
    const empty = await checkRequiredSectionsFilled(filePath);
    expect(empty.sort()).toEqual(
      ["Decisions and rationale", "Key changes from previous version", "Trigger"].sort(),
    );

    await appendToSection(filePath, "Trigger", "Just because.");
    await appendToSection(filePath, "Decisions and rationale", "- Did the thing.");
    const partial = await checkRequiredSectionsFilled(filePath);
    expect(partial).toEqual(["Key changes from previous version"]);

    await appendToSection(filePath, "Key changes from previous version", "- Changed something.");
    const all = await checkRequiredSectionsFilled(filePath);
    expect(all).toEqual([]);
  });
});
