import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { planManagerTool } from "../../tools/planning.js";
import { getPlanFile, getPlanDir, getDraftPlanFile } from "../plan-paths.js";

let tmp: string;
let originalEnv: string | undefined;

async function callTool(input: any): Promise<any> {
  // Adjust if SDK 0.2.128 surface differs.
  const handler = (planManagerTool as any).handler ?? (planManagerTool as any).execute;
  return handler(input);
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "runnai-mpr-"));
  originalEnv = process.env.RUNNAI_DATA_DIR;
  process.env.RUNNAI_DATA_DIR = tmp;
});
afterEach(async () => {
  if (originalEnv === undefined) delete process.env.RUNNAI_DATA_DIR;
  else process.env.RUNNAI_DATA_DIR = originalEnv;
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("manage_plan revise/finalize/discard", () => {
  test("revise creates draft, update writes to draft, discard removes it", async () => {
    await callTool({ action: "create", planName: "p", content: "# p\nbody" });
    await callTool({ action: "revise", planName: "p" });

    const updated = await callTool({ action: "update", planName: "p", content: "# p v2 draft\nnew body that's still long enough to pass the 50% check..............................." });
    expect(updated.content[0].text).toContain("draft");

    expect(await fs.readFile(getDraftPlanFile("p", 2), "utf-8")).toContain("v2 draft");
    expect(await fs.readFile(getPlanFile("p"), "utf-8")).not.toContain("v2 draft");

    await callTool({ action: "discard", planName: "p" });
    expect(await fs.access(path.join(getPlanDir("p"), ".draft-active")).catch(() => "missing")).toBe("missing");
  });

  test("finalize fails when reasoning sections empty unless allowEmpty", async () => {
    await callTool({ action: "create", planName: "p", content: "# p\nbody" });
    await callTool({ action: "revise", planName: "p" });
    await callTool({ action: "update", planName: "p", content: "# p v2\nlong enough body to pass the size guard..........................................." });

    const fail = await callTool({ action: "finalize", planName: "p" });
    expect(fail.isError).toBe(true);
    expect(fail.content[0].text.toLowerCase()).toContain("required sections");

    const ok = await callTool({ action: "finalize", planName: "p", allowEmpty: true });
    expect(ok.isError).toBeFalsy();
  });
});
