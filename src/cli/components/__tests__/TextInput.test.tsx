import { describe, test, expect } from "bun:test";
import { lineStart, lineEnd } from "../TextInput.js";

describe("lineStart / lineEnd (line-aware navigation helpers)", () => {
  describe("single-line input", () => {
    test("lineStart returns 0 for any cursor position", () => {
      expect(lineStart("hello world", 0)).toBe(0);
      expect(lineStart("hello world", 5)).toBe(0);
      expect(lineStart("hello world", 11)).toBe(0);
    });

    test("lineEnd returns end of value for any cursor position", () => {
      expect(lineEnd("hello world", 0)).toBe(11);
      expect(lineEnd("hello world", 5)).toBe(11);
      expect(lineEnd("hello world", 11)).toBe(11);
    });
  });

  describe("multi-line input", () => {
    // value: "abc\ndef\nghi"
    //         0123 4567 89AB  (positions)
    //         line1 line2 line3
    const v = "abc\ndef\nghi";

    test("lineStart finds start of current line", () => {
      // Cursor on line 1
      expect(lineStart(v, 0)).toBe(0);
      expect(lineStart(v, 1)).toBe(0);
      expect(lineStart(v, 3)).toBe(0); // on the \n itself, still line 1
      // Cursor on line 2
      expect(lineStart(v, 4)).toBe(4); // just after first \n
      expect(lineStart(v, 5)).toBe(4);
      expect(lineStart(v, 7)).toBe(4); // on second \n
      // Cursor on line 3
      expect(lineStart(v, 8)).toBe(8);
      expect(lineStart(v, 11)).toBe(8); // at end of value
    });

    test("lineEnd finds end of current line", () => {
      // Cursor on line 1
      expect(lineEnd(v, 0)).toBe(3); // position of first \n
      expect(lineEnd(v, 2)).toBe(3);
      expect(lineEnd(v, 3)).toBe(3); // on the \n itself
      // Cursor on line 2
      expect(lineEnd(v, 4)).toBe(7); // position of second \n
      expect(lineEnd(v, 6)).toBe(7);
      // Cursor on line 3
      expect(lineEnd(v, 8)).toBe(11);
      expect(lineEnd(v, 11)).toBe(11);
    });
  });

  describe("empty and edge inputs", () => {
    test("empty value: both helpers return 0", () => {
      expect(lineStart("", 0)).toBe(0);
      expect(lineEnd("", 0)).toBe(0);
    });

    test("single newline: lineStart respects line membership", () => {
      // value: "\n", positions 0 (before \n) and 1 (after)
      expect(lineStart("\n", 0)).toBe(0);
      expect(lineEnd("\n", 0)).toBe(0); // line 1 is empty, ends at \n position
      expect(lineStart("\n", 1)).toBe(1); // we're now on line 2 (also empty)
      expect(lineEnd("\n", 1)).toBe(1);
    });

    test("trailing newline: cursor past newline is on the empty next line", () => {
      const v = "abc\n";
      expect(lineStart(v, 4)).toBe(4); // cursor just after \n, on empty line 2
      expect(lineEnd(v, 4)).toBe(4); // empty line, ends here
    });
  });
});
