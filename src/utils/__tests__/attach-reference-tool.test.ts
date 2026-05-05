import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { attachReferenceTool } from "../../tools/references.js";
import { planManagerTool } from "../../tools/planning.js";
import { getReferencesIndex } from "../plan-paths.js";

let tmp: string;
let originalEnv: string | undefined;

async function call(tool: any, input: any) {
  const handler = (tool as any).handler ?? (tool as any).execute;
  return handler(input);
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "runnai-att-"));
  originalEnv = process.env.RUNNAI_DATA_DIR;
  process.env.RUNNAI_DATA_DIR = tmp;
});
afterEach(async () => {
  if (originalEnv === undefined) delete process.env.RUNNAI_DATA_DIR;
  else process.env.RUNNAI_DATA_DIR = originalEnv;
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("attach_reference tool", () => {
  test("copies file, writes INDEX, and links into reasoning if drafting", async () => {
    await call(planManagerTool, { action: "create", planName: "p", content: "# p\nbody" });

    const refSrc = path.join(tmp, "thresh.pdf");
    await fs.writeFile(refSrc, "%PDF-fake");

    const result = await call(attachReferenceTool, {
      planName: "p",
      filePath: refSrc,
      note: "the threshold plan",
    });
    expect(result.content[0].text).toContain("attached");
    expect(await fs.readFile(getReferencesIndex("p"), "utf-8")).toContain("thresh.pdf");

    // Now during a draft — should also write to reasoning.md.
    await call(planManagerTool, { action: "revise", planName: "p" });
    await call(attachReferenceTool, {
      planName: "p",
      filePath: refSrc,
      note: "still the threshold plan",
    });
    const reasoning = await fs.readFile(
      path.join(tmp, "plans", "p", "versions", "v2-draft", "reasoning.md"),
      "utf-8",
    );
    expect(reasoning).toContain("references/thresh.pdf");
  });
});
