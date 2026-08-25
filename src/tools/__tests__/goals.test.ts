import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { manageGoalsTool } from "../goals.js";
import { loadGoals } from "../../utils/goals.js";

let tmp: string;
let originalEnv: string | undefined;

async function call(input: any): Promise<string> {
  const handler = (manageGoalsTool as any).handler ?? (manageGoalsTool as any).execute;
  const res = await handler(input);
  return res.content.map((c: any) => c.text).join("\n");
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "runnai-goals-tool-"));
  originalEnv = process.env.RUNNAI_DATA_DIR;
  process.env.RUNNAI_DATA_DIR = tmp;
});

afterEach(async () => {
  if (originalEnv === undefined) delete process.env.RUNNAI_DATA_DIR;
  else process.env.RUNNAI_DATA_DIR = originalEnv;
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("manage_goals", () => {
  test("list on an empty store explains how to start", async () => {
    const out = await call({ action: "list" });
    expect(out).toContain("No goals recorded yet");
  });

  test("add creates a goal and reports its id", async () => {
    const out = await call({ action: "add", tier: "horizon", statement: "Sub-3 marathon", status: "aspiration", note: "raised in chat" });
    expect(out).toContain("sub-3-marathon");
    const store = await loadGoals();
    expect(store.goals[0].history[0].kind).toBe("created");
  });

  test("add of a north star requires the athlete to have confirmed the wording", async () => {
    const out = await call({ action: "add", tier: "northstar", statement: "Stay capable into old age" });
    expect(out).toContain("confirm");
    expect((await loadGoals()).goals).toHaveLength(0);
    await call({ action: "add", tier: "northstar", statement: "Stay capable into old age", why: "Independence", confirmedByAthlete: true });
    expect((await loadGoals()).goals).toHaveLength(1);
  });

  test("set_status records the transition and nudges a parent reassessment on achieved", async () => {
    await call({ action: "add", id: "sub-3", tier: "horizon", statement: "Sub-3 marathon", status: "committed" });
    await call({ action: "add", id: "rotterdam", tier: "event", statement: "Rotterdam Marathon", status: "active", parentId: "sub-3" });
    const out = await call({ action: "set_status", id: "rotterdam", status: "achieved", note: "3:05 in the heat" });
    expect(out).toContain("achieved");
    expect(out).toContain("Sub-3 marathon");
    expect((await loadGoals()).goals[1].history.at(-1)).toMatchObject({ kind: "status", to: "achieved" });
  });

  test("assess stores the coach's read", async () => {
    await call({ action: "add", id: "sub-3", tier: "horizon", statement: "Sub-3 marathon", status: "aspiration" });
    await call({ action: "assess", id: "sub-3", feasibility: "reachable", confidence: "medium", summary: "3-4 seasons of volume" });
    expect((await loadGoals()).goals[0].coachAssessment?.summary).toBe("3-4 seasons of volume");
  });

  test("list renders the tree with history on request", async () => {
    await call({ action: "add", id: "sub-3", tier: "horizon", statement: "Sub-3 marathon", status: "aspiration", note: "raised in chat" });
    const out = await call({ action: "list", includeHistory: true });
    expect(out).toContain("[aspiration] Sub-3 marathon");
    expect(out).toContain("created");
    expect(out).toContain("raised in chat");
  });

  test("unknown id returns an error result rather than throwing", async () => {
    const out = await call({ action: "set_status", id: "nope", status: "parked" });
    expect(out).toContain("No goal with id 'nope'");
  });
});
