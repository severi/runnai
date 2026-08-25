import { describe, test, expect } from "bun:test";
import { makeReplyLintHook } from "./agent.js";

const stop = (over: Record<string, unknown>) => ({
  hook_event_name: "Stop", session_id: "s", transcript_path: "/x", cwd: "/", permission_mode: "default",
  stop_hook_active: false, ...over,
}) as any;

describe("reply lint Stop hook", () => {
  test("clean reply passes through", async () => {
    const r = await makeReplyLintHook()(stop({ last_assistant_message: "Yes. Rest today." }), undefined, { signal: new AbortController().signal });
    expect(r).toEqual({});
  });
  test("bad reply is blocked once with the findings, and the UI is told to drop the draft", async () => {
    let dropped = 0;
    const hook = makeReplyLintHook({ onRejected: () => { dropped++; } });
    const r = await hook(stop({ last_assistant_message: "Basketball stays — lifts stay." }), undefined, { signal: new AbortController().signal });
    expect(r).toMatchObject({ decision: "block" });
    expect((r as any).reason).toContain("em dash");
    expect(dropped).toBe(1);
  });
  test("second stop of the same turn is let through", async () => {
    const r = await makeReplyLintHook()(stop({ last_assistant_message: "Still — bad.", stop_hook_active: true }), undefined, { signal: new AbortController().signal });
    expect(r).toEqual({});
  });
});
