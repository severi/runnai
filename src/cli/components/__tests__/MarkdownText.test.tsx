import { describe, test, expect } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { MarkdownText } from "../MarkdownText.js";

describe("MarkdownText", () => {
  test("renders inline strong/em outside tables", () => {
    const md = "Use **bold** and *italic*.";
    const { lastFrame } = render(<MarkdownText>{md}</MarkdownText>);
    const out = lastFrame()!;
    expect(out).toContain("bold");
    expect(out).toContain("italic");
    // The asterisks should NOT appear as literal characters.
    expect(out).not.toContain("**bold**");
    expect(out).not.toContain("*italic*");
  });

  test("renders a table with bold cells without dumping raw markdown", () => {
    const md = `| Day | Session | Role |
|---|---|---|
| Mon ✅ | Hill repeats 3×200m | **Quality session** |
| **Wed** | **Progressive 11km** | Second quality |
| **Sat** | **26km long run** | Key session |
`;
    const { lastFrame } = render(<MarkdownText>{md}</MarkdownText>);
    const out = lastFrame()!;

    // Header text appears.
    expect(out).toContain("Day");
    expect(out).toContain("Session");
    expect(out).toContain("Role");

    // Cell content appears.
    expect(out).toContain("Mon");
    expect(out).toContain("Wed");
    expect(out).toContain("Sat");
    expect(out).toContain("Hill repeats");
    expect(out).toContain("26km long run");

    // Crucially: the literal markdown markers must NOT be dumped raw.
    expect(out).not.toContain("**Wed**");
    expect(out).not.toContain("**Sat**");
    expect(out).not.toContain("**Quality session**");
    expect(out).not.toContain("|---|");
    expect(out).not.toContain("| Day |");
  });

  test("empty or zero-column tables don't crash", () => {
    // marked won't actually produce a table token from this, but this
    // exercises the empty-input path; should render without throwing.
    const md = "no tables here, just **bold** text.";
    const { lastFrame } = render(<MarkdownText>{md}</MarkdownText>);
    expect(lastFrame()).toBeTruthy();
  });
});
