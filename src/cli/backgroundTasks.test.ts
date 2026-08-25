import { describe, test, expect } from "bun:test";
import { applyTaskEvent, emptyBackgroundTasks, type BackgroundTasks } from "./backgroundTasks.js";

// Replays the exact sequence observed in a real session: the coach launched a
// researcher via Agent, the SDK backgrounded it, the Agent tool_result arrived
// immediately (so the foreground tools bar dropped it), the turn ended, and
// progress kept arriving between turns with nothing on screen.
const sid = "s";
const started = {
  type: "system", subtype: "task_started", task_id: "t1", tool_use_id: "tu1",
  description: "Research heat acclimation protocols", subagent_type: "researcher",
  task_type: "local_agent", uuid: "u1", session_id: sid,
} as any;
const changed = (ids: string[]) => ({
  type: "system", subtype: "background_tasks_changed", session_id: sid,
  tasks: ids.map((id) => ({ task_id: id, task_type: "local_agent", description: "Research heat acclimation protocols" })),
}) as any;
const progress = (summary: string) => ({
  type: "system", subtype: "task_progress", task_id: "t1", tool_use_id: "tu1",
  description: "Research heat acclimation protocols", subagent_type: "researcher", summary,
  usage: { total_tokens: 1, tool_uses: 1, duration_ms: 1 }, uuid: "u2", session_id: sid,
}) as any;
const done = {
  type: "system", subtype: "task_notification", task_id: "t1", tool_use_id: "tu1",
  status: "completed", output_file: "/x", summary: "Research saved to cache",
  usage: { total_tokens: 5, tool_uses: 30, duration_ms: 9000 }, uuid: "u3", session_id: sid,
} as any;

function run(events: any[], start: BackgroundTasks = emptyBackgroundTasks()) {
  let state = start;
  const notices: string[] = [];
  for (const e of events) {
    const r = applyTaskEvent(state, e);
    state = r.state;
    if (r.notice) notices.push(r.notice);
  }
  return { state, notices };
}

describe("background task tracking", () => {
  test("a backgrounded agent shows up with its description and latest progress summary", () => {
    const { state } = run([started, changed(["t1"]), progress("Reading cached heat research")]);
    expect(state.tasks).toEqual([
      { task_id: "t1", description: "Research heat acclimation protocols", subagent_type: "researcher", summary: "Reading cached heat research" },
    ]);
  });

  test("progress for a task the level signal never announced still surfaces it", () => {
    // Defensive: if background_tasks_changed is missed, task_progress alone must
    // not be dropped on the floor (that is exactly the bug we saw).
    const { state } = run([progress("Searching PubMed")]);
    expect(state.tasks.map((t) => t.task_id)).toEqual(["t1"]);
    expect(state.tasks[0].summary).toBe("Searching PubMed");
  });

  test("background_tasks_changed has replace semantics but keeps summaries of retained tasks", () => {
    const { state } = run([changed(["t1", "t2"]), progress("step 1"), changed(["t1"])]);
    expect(state.tasks.map((t) => t.task_id)).toEqual(["t1"]);
    expect(state.tasks[0].summary).toBe("step 1");
  });

  test("completion removes the task and yields a transcript notice", () => {
    const { state, notices } = run([changed(["t1"]), progress("x"), done]);
    expect(state.tasks).toEqual([]);
    expect(notices).toEqual(["Background researcher finished: Research saved to cache"]);
  });

  test("failure notice says so", () => {
    const { notices } = run([started, { ...done, status: "failed", summary: "boom" }]);
    expect(notices).toEqual(["Background researcher failed: boom"]);
  });

  test("unrelated messages leave state untouched", () => {
    const start = run([changed(["t1"])]).state;
    const r = applyTaskEvent(start, { type: "assistant", message: { content: [] } } as any);
    expect(r.state).toBe(start);
    expect(r.notice).toBeUndefined();
  });
});
