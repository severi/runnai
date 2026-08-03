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

// ─── Long text must wrap, not truncate ───────────────────────────────────────
// Inside <Static>, a Box with no bottom margin is measured one line tall and
// long text is truncated at the first line — silently, with no ellipsis. Only
// `marginBottom` changes the measurement (marginTop does not). ChatBubble and
// the `system` branch already carried marginBottom={1} and were fine; thinking,
// status, and tool_activity did not, so on 2026-08-03 the UI dropped the tail of
// every thinking summary and every long Bash command in the activity log —
// which read as tool lines "disappearing".
describe("MessageLog — long content wraps in every role", () => {
  // Verbatim thinking summary from session 9715e1dd.
  const LONG =
    "I need to track down references for Tactical Barbell / Fighter since it's not " +
    "showing up in the plan directory, so I'm checking the research index and searching memory for it.";
  const TAIL = "and searching memory for it.";

  const roles = ["thinking", "status", "assistant", "user", "system"] as const;

  for (const role of roles) {
    test(`${role}: tail survives instead of being cut at one line`, () => {
      const { lastFrame } = render(
        <Box flexDirection="column" padding={1}>
          <MessageLog items={[{ id: 1, message: { role, content: LONG } }]} />
        </Box>,
      );
      expect((lastFrame() ?? "").replace(/\s+/g, " ")).toContain(TAIL);
    });
  }

  test("tool_activity: a long command keeps its tail and its duration", () => {
    const label = "✓ [14] Bash: cd /tmp/tb_epub/text && python3 -c \"import re; print(open('part0028.html').read())\"";
    const { lastFrame } = render(
      <Box flexDirection="column" padding={1}>
        <MessageLog items={[{ id: 1, message: { role: "tool_activity", content: `${label}|||0.2s` } }]} />
      </Box>,
    );
    const out = (lastFrame() ?? "").replace(/\s+/g, " ");
    expect(out).toContain("part0028.html");
    expect(out).toContain("0.2s");
  });
});
