import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import {
  beginRevision,
  finalizeRevision,
  discardRevision,
} from "../plan-versions.js";
import {
  getPlanDir,
  getPlanFile,
  getDraftMarker,
  getDraftDir,
  getDraftPlanFile,
  getDraftReasoningFile,
  getVersionDir,
  getVersionPlanFile,
  isDraftActive,
} from "../plan-paths.js";
import { attachReference } from "../plan-references.js";
import { linkResearch } from "../plan-research-link.js";
import { appendToSection } from "../plan-reasoning.js";

let tmp: string;
let originalEnv: string | undefined;

async function bootstrapPlan(slug: string, content: string): Promise<void> {
  await fs.mkdir(getPlanDir(slug), { recursive: true });
  await fs.writeFile(getPlanFile(slug), content);
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "runnai-pv-"));
  originalEnv = process.env.RUNNAI_DATA_DIR;
  process.env.RUNNAI_DATA_DIR = tmp;
});
afterEach(async () => {
  if (originalEnv === undefined) delete process.env.RUNNAI_DATA_DIR;
  else process.env.RUNNAI_DATA_DIR = originalEnv;
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("plan-versions", () => {
  test("beginRevision creates v2-draft and marker, copies live plan", async () => {
    await bootstrapPlan("p", "# plan\n\nbody");
    await fs.mkdir(getVersionDir("p", 1), { recursive: true });
    await fs.writeFile(getVersionPlanFile("p", 1), "# plan\n\nbody");

    const result = await beginRevision("p");
    expect(result.draftVersion).toBe(2);
    expect(await isDraftActive("p")).toBe(true);
    expect(await fs.readFile(getDraftPlanFile("p", 2), "utf-8")).toBe("# plan\n\nbody");
    const reasoning = await fs.readFile(getDraftReasoningFile("p", 2), "utf-8");
    expect(reasoning).toContain("# v2");
    expect(reasoning).toContain("## Trigger");
  });

  test("beginRevision throws if a draft is already active", async () => {
    await bootstrapPlan("p", "# plan");
    await fs.writeFile(getDraftMarker("p"), "");
    await expect(beginRevision("p")).rejects.toThrow(/already.*draft/i);
  });

  test("finalizeRevision renames draft to vN, swaps live, removes marker, logs CHANGELOG", async () => {
    await bootstrapPlan("p", "# v1 plan");
    await fs.mkdir(getVersionDir("p", 1), { recursive: true });
    await fs.writeFile(getVersionPlanFile("p", 1), "# v1 plan");

    await beginRevision("p");
    await fs.writeFile(getDraftPlanFile("p", 2), "# v2 plan");
    await appendToSection(getDraftReasoningFile("p", 2), "Trigger", "Test trigger.");
    await appendToSection(getDraftReasoningFile("p", 2), "Decisions and rationale", "- did stuff");
    await appendToSection(getDraftReasoningFile("p", 2), "Key changes from previous version", "- v2 plan body");

    const result = await finalizeRevision("p", { allowEmpty: false });
    expect(result.version).toBe(2);
    expect(result.warnings).toEqual([]);

    expect(await fs.access(getDraftDir("p", 2)).catch(() => "missing")).toBe("missing");
    expect(await fs.readFile(getVersionPlanFile("p", 2), "utf-8")).toBe("# v2 plan");
    expect(await fs.readFile(getPlanFile("p"), "utf-8")).toBe("# v2 plan");
    expect(await isDraftActive("p")).toBe(false);

    const cl = await fs.readFile(path.join(getPlanDir("p"), "CHANGELOG.md"), "utf-8");
    expect(cl).toContain("v2");
  });

  test("finalizeRevision warns and aborts when required sections empty (default)", async () => {
    await bootstrapPlan("p", "# v1");
    await fs.mkdir(getVersionDir("p", 1), { recursive: true });
    await fs.writeFile(getVersionPlanFile("p", 1), "# v1");
    await beginRevision("p");
    await fs.writeFile(getDraftPlanFile("p", 2), "# v2");

    await expect(finalizeRevision("p", { allowEmpty: false })).rejects.toThrow(/required sections/i);
    expect(await isDraftActive("p")).toBe(true);
  });

  test("finalizeRevision proceeds with allowEmpty=true and reports warnings", async () => {
    await bootstrapPlan("p", "# v1");
    await fs.mkdir(getVersionDir("p", 1), { recursive: true });
    await fs.writeFile(getVersionPlanFile("p", 1), "# v1");
    await beginRevision("p");
    await fs.writeFile(getDraftPlanFile("p", 2), "# v2");

    const result = await finalizeRevision("p", { allowEmpty: true });
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(await isDraftActive("p")).toBe(false);
  });

  test("finalizeRevision updates Used in versions for cited refs and research", async () => {
    await bootstrapPlan("p", "# v1");
    await fs.mkdir(getVersionDir("p", 1), { recursive: true });
    await fs.writeFile(getVersionPlanFile("p", 1), "# v1");

    const refSrc = path.join(tmp, "thresh.pdf");
    await fs.writeFile(refSrc, "x");
    await attachReference("p", refSrc, "the plan");
    await linkResearch("p", "ultra-research.md", "informed v2");

    await beginRevision("p");
    await fs.writeFile(getDraftPlanFile("p", 2), "# v2");
    await appendToSection(getDraftReasoningFile("p", 2), "Trigger", "x");
    await appendToSection(getDraftReasoningFile("p", 2), "Decisions and rationale", "x");
    await appendToSection(getDraftReasoningFile("p", 2), "Key changes from previous version", "x");
    await appendToSection(
      getDraftReasoningFile("p", 2),
      "Sources consulted",
      "- references/thresh.pdf — the plan\n- research/ultra-research.md — informed v2",
    );

    await finalizeRevision("p", { allowEmpty: false });

    const refsIndex = await fs.readFile(
      path.join(getPlanDir("p"), "references", "INDEX.md"),
      "utf-8",
    );
    expect(refsIndex).toContain("Used in versions: v2");

    const researchIndex = await fs.readFile(
      path.join(getPlanDir("p"), "research", "INDEX.md"),
      "utf-8",
    );
    expect(researchIndex).toContain("Used in versions: v2");
  });

  test("discardRevision removes draft dir and marker, leaves live plan untouched", async () => {
    await bootstrapPlan("p", "# v1 plan");
    await fs.mkdir(getVersionDir("p", 1), { recursive: true });
    await fs.writeFile(getVersionPlanFile("p", 1), "# v1 plan");

    await beginRevision("p");
    await fs.writeFile(getDraftPlanFile("p", 2), "# unwanted v2");

    await discardRevision("p");
    expect(await isDraftActive("p")).toBe(false);
    expect(await fs.access(getDraftDir("p", 2)).catch(() => "missing")).toBe("missing");
    expect(await fs.readFile(getPlanFile("p"), "utf-8")).toBe("# v1 plan");
  });

  test("discardRevision is a no-op if no draft active", async () => {
    await bootstrapPlan("p", "# v1");
    await discardRevision("p");
    expect(await isDraftActive("p")).toBe(false);
  });
});
