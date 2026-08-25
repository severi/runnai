import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import {
  loadGoals,
  addGoal,
  updateGoal,
  setGoalStatus,
  assessGoal,
  findTensions,
  renderGoalsBlock,
  type GoalsFile,
} from "./goals.js";

let tmp: string;
let originalEnv: string | undefined;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "runnai-goals-"));
  originalEnv = process.env.RUNNAI_DATA_DIR;
  process.env.RUNNAI_DATA_DIR = tmp;
  await fs.mkdir(path.join(tmp, "athlete"), { recursive: true });
});

afterEach(async () => {
  if (originalEnv === undefined) delete process.env.RUNNAI_DATA_DIR;
  else process.env.RUNNAI_DATA_DIR = originalEnv;
  await fs.rm(tmp, { recursive: true, force: true });
});

const TODAY = "2026-08-25";

describe("goals store", () => {
  test("loads an empty store when goals.json does not exist", async () => {
    const store = await loadGoals();
    expect(store.goals).toEqual([]);
  });

  test("addGoal persists the goal with a created history entry", async () => {
    await addGoal({ id: "sub-3", tier: "horizon", statement: "Run a sub-3:00 marathon", status: "aspiration" }, TODAY, "raised in chat");
    const store = await loadGoals();
    expect(store.goals).toHaveLength(1);
    expect(store.goals[0].history).toEqual([{ date: TODAY, kind: "created", note: "raised in chat" }]);
  });

  test("addGoal derives a slug id when none is given", async () => {
    const goal = await addGoal({ tier: "event", statement: "Rotterdam Marathon 2026", status: "active" }, TODAY);
    expect(goal.id).toBe("rotterdam-marathon-2026");
  });

  test("addGoal rejects a duplicate id", async () => {
    await addGoal({ id: "sub-3", tier: "horizon", statement: "Sub-3", status: "aspiration" }, TODAY);
    await expect(addGoal({ id: "sub-3", tier: "horizon", statement: "Sub-3 again", status: "aspiration" }, TODAY)).rejects.toThrow(/already exists/);
  });

  test("addGoal rejects an unknown parentId", async () => {
    await expect(addGoal({ tier: "event", statement: "Race", status: "active", parentId: "nope" }, TODAY)).rejects.toThrow(/parent/);
  });

  test("restating a goal keeps the old wording in history", async () => {
    await addGoal({ id: "north", tier: "northstar", statement: "Stay capable into old age", why: "Independence at 80", status: "active" }, TODAY);
    await updateGoal("north", { statement: "Be strong and mobile at 80" }, "2026-09-01", "athlete confirmed the rewording");
    const store = await loadGoals();
    const g = store.goals[0];
    expect(g.statement).toBe("Be strong and mobile at 80");
    expect(g.history.at(-1)).toEqual({
      date: "2026-09-01",
      kind: "restated",
      from: "Stay capable into old age",
      to: "Be strong and mobile at 80",
      note: "athlete confirmed the rewording",
    });
  });

  test("setGoalStatus records the transition", async () => {
    await addGoal({ id: "sub-3", tier: "horizon", statement: "Sub-3", status: "aspiration" }, TODAY);
    await setGoalStatus("sub-3", "committed", "2026-10-01", "signed up for the spring build");
    const g = (await loadGoals()).goals[0];
    expect(g.status).toBe("committed");
    expect(g.history.at(-1)).toEqual({ date: "2026-10-01", kind: "status", from: "aspiration", to: "committed", note: "signed up for the spring build" });
  });

  test("assessGoal replaces the coach assessment and archives the previous one", async () => {
    await addGoal({ id: "sub-3", tier: "horizon", statement: "Sub-3", status: "aspiration" }, TODAY);
    await assessGoal("sub-3", { date: TODAY, feasibility: "reachable", confidence: "medium", summary: "3-4 seasons" });
    await assessGoal("sub-3", { date: "2027-03-01", feasibility: "reachable", confidence: "high", summary: "threshold moved" });
    const g = (await loadGoals()).goals[0];
    expect(g.coachAssessment?.confidence).toBe("high");
    expect(g.history.at(-1)).toEqual({ date: "2027-03-01", kind: "assessed", note: "reachable (high): threshold moved" });
    expect(g.history.at(-2)).toEqual({ date: TODAY, kind: "assessed", note: "reachable (medium): 3-4 seasons" });
  });
});

describe("findTensions", () => {
  test("flags two concurrently committed horizon goals", () => {
    const store: GoalsFile = { version: 1, goals: [
      { id: "a", tier: "horizon", statement: "Sub-3 marathon", status: "committed", history: [] },
      { id: "b", tier: "horizon", statement: "100km ultra", status: "active", history: [] },
    ] };
    expect(findTensions(store)).toEqual(["Sub-3 marathon and 100km ultra are both live horizon goals — worth naming which leads this season."]);
  });

  test("flags an active event whose parent is parked", () => {
    const store: GoalsFile = { version: 1, goals: [
      { id: "a", tier: "horizon", statement: "Sub-3 marathon", status: "parked", history: [] },
      { id: "r", tier: "event", statement: "Rotterdam Marathon", status: "active", parentId: "a", history: [] },
    ] };
    expect(findTensions(store)).toEqual(["Rotterdam Marathon is active but the goal it serves (Sub-3 marathon) is parked."]);
  });

  test("is quiet when nothing overlaps", () => {
    const store: GoalsFile = { version: 1, goals: [
      { id: "a", tier: "horizon", statement: "Sub-3 marathon", status: "committed", history: [] },
      { id: "b", tier: "horizon", statement: "100km ultra", status: "aspiration", history: [] },
    ] };
    expect(findTensions(store)).toEqual([]);
  });
});

describe("renderGoalsBlock", () => {
  test("returns empty string when there are no goals", () => {
    expect(renderGoalsBlock({ version: 1, goals: [] })).toBe("");
  });

  test("renders the hierarchy and omits achieved and abandoned goals", () => {
    const store: GoalsFile = { version: 1, goals: [
      { id: "north", tier: "northstar", statement: "Stay capable into old age", why: "Independence at 80", status: "active", history: [] },
      { id: "sub-3", tier: "horizon", statement: "Sub-3 marathon", status: "committed", parentId: "north",
        target: { window: "2027-2028", metric: "sub 3:00" },
        coachAssessment: { date: "2026-08-24", feasibility: "reachable", confidence: "medium", summary: "3-4 seasons", detailRef: "memory/race-predictions/sub-3.md" },
        history: [] },
      { id: "ultra", tier: "horizon", statement: "100km ultra", status: "parked", history: [] },
      { id: "rotterdam", tier: "event", statement: "Rotterdam Marathon", status: "active", parentId: "sub-3",
        target: { date: "2026-04-19", metric: "by effort" }, planSlug: "rotterdam-marathon-2026", history: [] },
      { id: "old", tier: "event", statement: "Forest Classic Trail Marathon", status: "achieved", history: [] },
      { id: "gone", tier: "horizon", statement: "Ironman", status: "abandoned", history: [] },
    ] };
    const block = renderGoalsBlock(store);
    expect(block).toContain("North star: Stay capable into old age — Independence at 80");
    expect(block).toContain("- [committed] Sub-3 marathon · 2027-2028 · sub 3:00 · coach: reachable (medium, 2026-08-24) · detail: memory/race-predictions/sub-3.md");
    expect(block).toContain("- [active] Rotterdam Marathon · 2026-04-19 · by effort · serves: Sub-3 marathon · plan: rotterdam-marathon-2026");
    expect(block).toContain("Parked: 100km ultra");
    expect(block).not.toContain("Forest Classic");
    expect(block).not.toContain("Ironman");
  });
});
