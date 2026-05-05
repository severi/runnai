import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { planManagerTool } from "../../tools/planning.js";
import { attachReferenceTool } from "../../tools/references.js";
import { linkResearchTool } from "../../tools/research-link.js";
import {
  getPlanFile,
  getDraftPlanFile,
  getDraftReasoningFile,
  getReferencesIndex,
  getResearchIndex,
  isDraftActive,
} from "../plan-paths.js";

let tmp: string;
let originalEnv: string | undefined;
async function call(t: any, input: any) {
  const handler = (t as any).handler ?? (t as any).execute;
  const result = await handler(input);
  if (result.isError) throw new Error(`tool call errored: ${result.content[0].text}`);
  return result;
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "runnai-e2e-"));
  originalEnv = process.env.RUNNAI_DATA_DIR;
  process.env.RUNNAI_DATA_DIR = tmp;
});
afterEach(async () => {
  if (originalEnv === undefined) delete process.env.RUNNAI_DATA_DIR;
  else process.env.RUNNAI_DATA_DIR = originalEnv;
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("plan redesign — full revision loop", () => {
  test("create → revise → attach → link → update draft → diff → finalize", async () => {
    const initial = `# Initial plan\n\n## Week 1: Build\n\n| Day | Date | Session | Details |\n|-----|------|---------|---------|\n| Mon | Mar 9 | Easy | 9km easy. |\n`;
    await call(planManagerTool, { action: "create", planName: "trial", content: initial });

    // Enter revision mode.
    await call(planManagerTool, { action: "revise", planName: "trial" });
    expect(await isDraftActive("trial")).toBe(true);

    // Attach a reference.
    const ref = path.join(tmp, "ref.pdf");
    await fs.writeFile(ref, "pdf-bytes");
    await call(attachReferenceTool, { planName: "trial", filePath: ref, note: "the basis plan" });

    // Link research.
    await call(linkResearchTool, { planName: "trial", researchFilename: "topic.md", note: "informed v2" });

    // Edit the draft.
    const v2 = initial.replace("9km easy.", "11km easy.") + "\n## Week 2: Peak\n";
    await call(planManagerTool, { action: "update", planName: "trial", content: v2 });

    // Reasoning sections need to be filled before finalize.
    const reasoningPath = getDraftReasoningFile("trial", 2);
    const { appendToSection } = await import("../plan-reasoning.js");
    await appendToSection(reasoningPath, "Trigger", "Test trigger.");
    await appendToSection(reasoningPath, "Decisions and rationale", "- bumped easy day 9→11");
    await appendToSection(reasoningPath, "Key changes from previous version", "- added week 2");

    // Diff renders.
    const diffOut = await call(planManagerTool, { action: "diff", planName: "trial" });
    expect(diffOut.content[0].text).toContain("diff written");

    // Finalize.
    await call(planManagerTool, { action: "finalize", planName: "trial" });
    expect(await isDraftActive("trial")).toBe(false);
    expect(await fs.readFile(getPlanFile("trial"), "utf-8")).toContain("11km easy");

    // Used in versions populated.
    expect(await fs.readFile(getReferencesIndex("trial"), "utf-8")).toContain("Used in versions: v2");
    expect(await fs.readFile(getResearchIndex("trial"), "utf-8")).toContain("Used in versions: v2");
  });

  test("discard rolls back cleanly", async () => {
    const initial = "# initial\nbody";
    await call(planManagerTool, { action: "create", planName: "t", content: initial });
    await call(planManagerTool, { action: "revise", planName: "t" });
    await call(planManagerTool, { action: "update", planName: "t", content: "# edited draft\nlong body that passes the 50% size guard...................................." });
    await call(planManagerTool, { action: "discard", planName: "t" });
    expect(await isDraftActive("t")).toBe(false);
    const live = await fs.readFile(getPlanFile("t"), "utf-8");
    expect(live).toContain("initial");
    expect(live).not.toContain("edited draft");
  });
});
