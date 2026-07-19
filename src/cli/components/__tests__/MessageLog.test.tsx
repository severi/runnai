import { describe, test, expect } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { Box } from "ink";
import { MessageLog } from "../MessageLog.js";

// Real coach output from session 34dbc9fb (2026-07-19) — the message shape
// that regressed: prose + a 3-column table with long cells.
const md = `Solid easy run. Summary:

| Metric | Value | Read |
|---|---|---|
| Avg HR | 150 bpm | Top of Z2 easy (134–152) — aerobic, not tempo |
| Pace / GAP | 5:23 / 5:15 per km | Fast edge of easy (5:20–5:40); GAP just under the floor |
| Cardiac drift | 1.2% | Excellent — near-zero decoupling over 82 min |
| Zone time | ~38 min Z2 / ~40 min Z3 | The "Z3" is HR hovering just over the 152 line, not real threshold work |

Nice work today.`;

describe("MessageLog", () => {
  // Regression: <Static> is absolutely positioned so it sizes to CONTENT unless
  // given an explicit width. Without width:"100%", this message collapsed to the
  // width of its intro sentence (~24 cols): flex table cells shrank to one word
  // (or one LETTER) per line and a 9-line message exploded into 300+ lines of
  // mostly blank padding. If this test starts failing on line count or a
  // split-up header, the Static width was probably lost.
  test("tables in committed messages render at terminal width, not content width", () => {
    const { lastFrame } = render(
      <Box flexDirection="column" padding={1}>
        <MessageLog items={[{ id: 1, message: { role: "assistant", content: md } }]} />
      </Box>
    );
    const lines = lastFrame()!.split("\n");

    // Header row must be one line with all three column titles on it.
    const header = lines.find((l) => l.includes("Metric"));
    expect(header).toBeDefined();
    expect(header!).toContain("Value");
    expect(header!).toContain("Read");

    // The collapsed layout produced 300+ lines; a healthy render is ~20.
    expect(lines.length).toBeLessThan(40);

    // No blank-line bursts (collapsed row-stretch padding produced runs of 5+).
    let run = 0;
    let maxRun = 0;
    for (const l of lines) {
      run = l.trim() === "" ? run + 1 : 0;
      if (run > maxRun) maxRun = run;
    }
    expect(maxRun).toBeLessThanOrEqual(2);

    // Long prose cells stay intact (never truncated).
    expect(lastFrame()!).toContain("not tempo");
  });
});
