import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { linkResearchTool } from "../../tools/research-link.js";
import { planManagerTool } from "../../tools/planning.js";
import { getResearchIndex } from "../plan-paths.js";

let tmp: string;
let originalEnv: string | undefined;
async function call(tool: any, input: any) {
  const handler = (tool as any).handler ?? (tool as any).execute;
  return handler(input);
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "runnai-rlt-"));
  originalEnv = process.env.RUNNAI_DATA_DIR;
  process.env.RUNNAI_DATA_DIR = tmp;
});
afterEach(async () => {
  if (originalEnv === undefined) delete process.env.RUNNAI_DATA_DIR;
  else process.env.RUNNAI_DATA_DIR = originalEnv;
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("link_research tool", () => {
  test("appends entry to research INDEX and writes Sources line during draft", async () => {
    await call(planManagerTool, { action: "create", planName: "p", content: "# p\nbody" });
    await call(planManagerTool, { action: "revise", planName: "p" });

    await call(linkResearchTool, {
      planName: "p",
      researchFilename: "ultra-training.md",
      note: "informed v2",
    });

    expect(await fs.readFile(getResearchIndex("p"), "utf-8")).toContain("ultra-training.md");
    const reasoning = await fs.readFile(
      path.join(tmp, "plans", "p", "versions", "v2-draft", "reasoning.md"),
      "utf-8",
    );
    expect(reasoning).toContain("research/ultra-training.md");
  });
});
