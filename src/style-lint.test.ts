import { describe, test, expect } from "bun:test";
import { lintReply, formatLintReason } from "./style-lint.js";

const rules = (text: string) => lintReply(text).map((f) => f.rule);

describe("lintReply — banned constructions from the Voice section", () => {
  test("a plain, well-formed reply passes", () => {
    const text = [
      "# Sub-3 marathon: reachable on a 3 to 4 year timeline",
      "",
      "Yes. The realistic window is three to four years out.",
      "",
      "| Quantity | Now | Needed |",
      "|---|---|---|",
      "| Threshold pace | 4:15/km | 3:56 to 4:05/km |",
      "",
      "- **Peak volume:** 95 to 110 km a week.",
      "- **Seasons:** three or four, back to back.",
      "",
      "The one session that has to survive every week is the threshold run.",
    ].join("\n");
    expect(lintReply(text)).toEqual([]);
  });

  test("flags em dashes with the offending line", () => {
    const f = lintReply("Basketball stays — both lifts stay too.");
    expect(f).toHaveLength(1);
    expect(f[0].rule).toBe("em-dash");
    expect(f[0].line).toBe(1);
    expect(f[0].excerpt).toContain("Basketball stays");
  });

  test("ignores em dashes inside code fences", () => {
    expect(rules("```\na — b\n```\nFine.")).toEqual([]);
  });

  test("flags 'and isn't' and 'not X, it's Y' antithesis when used more than once", () => {
    const text = [
      "That sounds encouraging and isn't, because nobody races a marathon at threshold.",
      "That's arithmetic, not a training philosophy.",
      "It needs no growth in your engine. It needs your threshold to climb.",
    ].join("\n");
    const f = lintReply(text).filter((x) => x.rule === "antithesis");
    expect(f.length).toBeGreaterThanOrEqual(2);
  });

  test("allows a single antithesis", () => {
    expect(rules("The limiter is durability, not speed. Easy volume is what builds it.")).toEqual([]);
  });

  test("flags sentences over 40 words", () => {
    const long = "Run that requirement back through your own lab test and you find that the threshold at four minutes per kilometre would put you at eighty two percent of that same maximum which is exactly the range that trained endurance athletes usually sit in when they are tested properly.";
    expect(rules(long)).toEqual(["long-sentence"]);
  });

  test("a colon-joined sentence is counted as two clauses", () => {
    const text = "Two things have to move: the threshold pace has to come down by four to eight percent over the next three seasons, and the ratio of marathon pace to threshold pace has to rise from the mid eighties to the low nineties.";
    expect(rules(text)).toEqual([]);
  });

  test("flags clear bold overuse in prose, but not list labels or headers", () => {
    const ok = [
      "## Heading",
      "- **Volume:** 100km",
      "- **Weeks:** 24",
      "- **Runs:** six",
      "So the **spring** decides it and the **autumn** is fine.",
    ].join("\n");
    expect(rules(ok)).toEqual([]);
    const bad = ok + "\n**The fix is smaller than it sounds.** Nothing else changes.\n**Autumn stays.** **Lifting stays.** **The race moves.**";
    expect(rules(bad)).toEqual(["bold-overuse"]);
  });

  test("formatLintReason names each rule with its line", () => {
    const reason = formatLintReason(lintReply("A — B.\nC — D."));
    expect(reason).toContain("line 1");
    expect(reason).toContain("line 2");
    expect(reason).toContain("em dash");
  });
});
