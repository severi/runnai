import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { planManagerTool } from "../../tools/planning.js";
import { getPlanFile, getPlanDir, getDraftPlanFile } from "../plan-paths.js";

// ─── Targeted plan edits ─────────────────────────────────────────────────────
// `update` used to accept only a full-file replacement, so recording one
// session's actuals meant reproducing a ~200-line plan verbatim. The coach
// rationally reached for the generic Edit tool instead — four times in one
// session (2026-08-04) — which writes the file but skips the changelog and the
// version snapshot entirely. plan CHANGELOG.md sat unchanged from 2026-07-27
// while the plan itself kept moving. A rule the tooling makes irrational to
// follow is a tooling problem, so update now takes oldString/newString.

const WEEK = `# Plan

## Week 1

| Day | Session |
|-----|---------|
| Mon Aug 3 | **Lift A** — lift only, no run |
| Tue Aug 4 | Easy Z2 run |
| Wed Aug 5 | Easy Z2 run |
`;

let tmp: string;
let originalEnv: string | undefined;

async function call(input: any): Promise<any> {
  const handler = (planManagerTool as any).handler ?? (planManagerTool as any).execute;
  return handler(input);
}
const textOf = (r: any) => r.content?.[0]?.text ?? "";

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "runnai-mpp-"));
  originalEnv = process.env.RUNNAI_DATA_DIR;
  process.env.RUNNAI_DATA_DIR = tmp;
  await call({ action: "create", planName: "p", content: WEEK });
});
afterEach(async () => {
  if (originalEnv === undefined) delete process.env.RUNNAI_DATA_DIR;
  else process.env.RUNNAI_DATA_DIR = originalEnv;
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("manage_plan update — targeted edit", () => {
  test("replaces one row and leaves the rest of the plan intact", async () => {
    const res = await call({
      action: "update",
      planName: "p",
      oldString: "| Mon Aug 3 | **Lift A** — lift only, no run |",
      newString: "| Mon Aug 3 | **Lift A** — lift only, no run · ✅ done, 46min |",
    });
    expect(res.isError).toBeFalsy();

    const after = await fs.readFile(getPlanFile("p"), "utf-8");
    expect(after).toContain("✅ done, 46min");
    expect(after).toContain("| Tue Aug 4 | Easy Z2 run |");
    expect(after).toContain("| Wed Aug 5 | Easy Z2 run |");
  });

  test("writes a changelog entry — the whole reason this path exists", async () => {
    await call({
      action: "update",
      planName: "p",
      oldString: "| Mon Aug 3 | **Lift A** — lift only, no run |",
      newString: "| Mon Aug 3 | **Lift A** · ✅ done |",
    });
    const log = await fs.readFile(path.join(getPlanDir("p"), "CHANGELOG.md"), "utf-8");
    expect(log).toContain("plan updated");
    expect(log).toContain("Targeted edit");
    // The entry should show what actually changed, not just that something did.
    expect(log).toContain("✅ done");
  });

  test("an ambiguous match changes nothing and says how many it hit", async () => {
    const res = await call({
      action: "update",
      planName: "p",
      oldString: "| Easy Z2 run |",   // appears on both Tue and Wed
      newString: "| Easy Z2 run ✅ |",
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("2 places");
    const after = await fs.readFile(getPlanFile("p"), "utf-8");
    expect(after).toBe(await fs.readFile(path.join(getPlanDir("p"), "versions/v1/plan.md"), "utf-8"));
  });

  test("a missing match is an error, not a silent no-op", async () => {
    const res = await call({
      action: "update",
      planName: "p",
      oldString: "| Fri Aug 7 | Rest |",
      newString: "| Fri Aug 7 | Rest ✅ |",
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("not found");
  });

  test("oldString without newString is rejected rather than deleting text", async () => {
    const res = await call({
      action: "update",
      planName: "p",
      oldString: "| Tue Aug 4 | Easy Z2 run |",
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("BOTH");
  });

  test("update with neither content nor a patch is rejected", async () => {
    const res = await call({ action: "update", planName: "p" });
    expect(res.isError).toBe(true);
  });

  test("full-file replacement still works", async () => {
    const ok = await call({ action: "update", planName: "p", content: WEEK + "\n| Thu Aug 6 | **Lift B** |\n" });
    expect(ok.isError).toBeFalsy();
    expect(await fs.readFile(getPlanFile("p"), "utf-8")).toContain("Lift B");
  });

  test("the shrink guard still protects a real-sized plan from a truncated replacement", async () => {
    // The guard only engages above 500 chars, so a realistic plan is needed —
    // it exists to catch a full replacement that silently drops most of the file.
    const big = WEEK + Array.from({ length: 40 }, (_, i) => `| Day ${i} | Easy run number ${i} |`).join("\n");
    await call({ action: "update", planName: "p", content: big });

    const shrunk = await call({ action: "update", planName: "p", content: "# p\nonly a heading" });
    expect(shrunk.isError).toBe(true);
    expect(textOf(shrunk)).toContain("much shorter");
    // And it points at the cheaper path rather than just refusing.
    expect(textOf(shrunk)).toContain("oldString");
    expect(await fs.readFile(getPlanFile("p"), "utf-8")).toContain("Easy run number 39");
  });

  test("during a revision the patch lands on the draft, not the live plan", async () => {
    await call({ action: "revise", planName: "p" });
    await call({
      action: "update",
      planName: "p",
      oldString: "| Tue Aug 4 | Easy Z2 run |",
      newString: "| Tue Aug 4 | Easy Z2 run · moved |",
    });

    const draft = await fs.readFile(getDraftPlanFile("p", 2), "utf-8");
    expect(draft).toContain("moved");
    const live = await fs.readFile(getPlanFile("p"), "utf-8");
    expect(live).not.toContain("moved");
  });
});
