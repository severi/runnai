import { describe, test, expect } from "bun:test";
import {
  replaceContextSection,
  looksLikePartialContext,
  countContextSections,
} from "../context-md.js";

const CONTEXT = `# Athlete Context

## Profile
- Name: Alex
- Age: 35

## HR Zones (from lab — Feb 1, 2026)
- Z1: 110–130 bpm
- Z2: 131–145 bpm

## Current Training Plan
- Phase: ULTRA build
- Weekly volume: 60km

## Shoes
- Speedgoat: 400km

## Coach Notes
- Prefers first-principles reasoning
`;

describe("replaceContextSection", () => {
  test("replaces only the named section, preserving everything else", () => {
    const res = replaceContextSection(
      CONTEXT,
      "Current Training Plan",
      "- Phase: POST-ULTRA RECOVERY\n- Return progression underway",
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // New body present under the preserved heading
    expect(res.result).toContain("## Current Training Plan");
    expect(res.result).toContain("POST-ULTRA RECOVERY");
    expect(res.result).not.toContain("ULTRA build");
    // Everything else survives — this is the regression that wiped the hot cache
    expect(res.result).toContain("## Profile");
    expect(res.result).toContain("## HR Zones (from lab — Feb 1, 2026)");
    expect(res.result).toContain("## Shoes");
    expect(res.result).toContain("## Coach Notes");
    expect(res.result).toContain("Prefers first-principles reasoning");
    expect(countContextSections(res.result)).toBe(countContextSections(CONTEXT));
  });

  test("section match is case-insensitive and heading not duplicated when content includes it", () => {
    const res = replaceContextSection(
      CONTEXT,
      "current training plan",
      "## Current Training Plan\n- Phase: taper",
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const headingCount = res.result.split("\n").filter((l) => l.startsWith("## Current Training Plan")).length;
    expect(headingCount).toBe(1);
    expect(res.result).toContain("Phase: taper");
  });

  test("replacing the last section keeps prior sections", () => {
    const res = replaceContextSection(CONTEXT, "Coach Notes", "- New note");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.result).toContain("- New note");
    expect(res.result).toContain("## Shoes");
    expect(res.result).not.toContain("first-principles");
  });

  test("unknown section errors and lists available sections", () => {
    const res = replaceContextSection(CONTEXT, "Nutrition", "- gels");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain("not found");
    expect(res.error).toContain("Current Training Plan");
    expect(res.error).toContain("Coach Notes");
  });
});

describe("looksLikePartialContext", () => {
  test("flags a single-section body sent as a full replace (the wipe scenario)", () => {
    const partial = "- Phase: POST-ULTRA RECOVERY (started Jul 12)\n- Return progression: two easy jogs";
    expect(looksLikePartialContext(CONTEXT, partial)).toBe(true);
  });

  test("accepts a genuine full-file rewrite", () => {
    expect(looksLikePartialContext(CONTEXT, CONTEXT.replace("60km", "45km"))).toBe(false);
  });

  test("does not block writes when existing file is small/unstructured", () => {
    expect(looksLikePartialContext("# Athlete Context\n\n[not set]", "## Profile\n- Name: X")).toBe(false);
  });
});
