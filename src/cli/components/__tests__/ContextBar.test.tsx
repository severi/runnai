import { describe, test, expect } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { ContextBar } from "../ContextBar.js";

describe("ContextBar", () => {
  test("renders bar, percent, and token counts", () => {
    const { lastFrame } = render(<ContextBar used={250_000} total={1_000_000} />);
    const out = lastFrame()!;
    expect(out).toContain("context");
    expect(out).toContain("250.0k");
    expect(out).toContain("1.00M");
    expect(out).toContain("25.0%");
    // Bar uses block characters
    expect(out).toMatch(/[█░]+/);
  });

  test("formats small token counts without unit suffix", () => {
    // Both under 1000 → no unit suffix.
    const { lastFrame } = render(<ContextBar used={250} total={999} />);
    const out = lastFrame()!;
    expect(out).toContain("250/999");
  });

  test("shows compaction warning when usage is very high", () => {
    const { lastFrame } = render(<ContextBar used={900_000} total={1_000_000} />);
    const out = lastFrame()!;
    expect(out).toContain("compaction soon");
    expect(out).toContain("90.0%");
  });

  test("does not show warning below 85%", () => {
    const { lastFrame } = render(<ContextBar used={800_000} total={1_000_000} />);
    const out = lastFrame()!;
    expect(out).not.toContain("compaction soon");
  });

  test("returns null for zero/negative total (degenerate input)", () => {
    const { lastFrame } = render(<ContextBar used={0} total={0} />);
    expect(lastFrame()).toBe("");
  });

  test("clamps the bar at 100% even when used > total", () => {
    const { lastFrame } = render(<ContextBar used={2_000_000} total={1_000_000} />);
    const out = lastFrame()!;
    expect(out).toContain("200.0%");
    // Bar should be fully filled — 20 of the same character (block).
    expect(out).toMatch(/█{20}/);
  });
});
