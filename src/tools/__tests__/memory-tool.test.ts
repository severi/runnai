import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import {
  readMemoryTool,
  writeMemoryTool,
  sliceMemory,
  shrinkGuardError,
  READ_MEMORY_CHAR_BUDGET,
} from "../memory.js";

let tmp: string;
let originalEnv: string | undefined;

async function call(tool: any, input: any) {
  const handler = (tool as any).handler ?? (tool as any).execute;
  return handler(input);
}

function text(res: any): string {
  return res.content[0].text;
}

async function readLog(): Promise<string> {
  return fs.readFile(path.join(tmp, "memory", "log.md"), "utf-8");
}

// A dated log the size of a real strength log: ~1000 lines, well past the budget.
function bigLog(): string {
  const lines: string[] = ["# Strength log", ""];
  for (let i = 1; i <= 120; i++) {
    lines.push(`## 2026-01-${String((i % 28) + 1).padStart(2, "0")} — session ${i}`);
    for (let j = 0; j < 7; j++) lines.push(`| Lift ${j} | 5 × 5 × ${80 + j} kg | rest 3:00 | ${"x".repeat(40)} |`);
    lines.push("");
  }
  return lines.join("\n");
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "runnai-memory-tool-"));
  await fs.mkdir(path.join(tmp, "memory"), { recursive: true });
  originalEnv = process.env.RUNNAI_DATA_DIR;
  process.env.RUNNAI_DATA_DIR = tmp;
});

afterEach(async () => {
  if (originalEnv === undefined) delete process.env.RUNNAI_DATA_DIR;
  else process.env.RUNNAI_DATA_DIR = originalEnv;
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("write_memory — append vs overwrite", () => {
  test("append: true adds to the end and keeps the history", async () => {
    await fs.writeFile(path.join(tmp, "memory", "log.md"), bigLog());
    const before = (await readLog()).split("\n").length;
    const res = await call(writeMemoryTool, { file: "log.md", content: "### new entry", append: true });
    expect(res.isError).toBeUndefined();
    const after = await readLog();
    expect(after.split("\n").length).toBe(before + 1);
    expect(after.endsWith("\n### new entry")).toBe(true);
  });

  test("mode: 'append' (the alias the agent actually sent) also appends", async () => {
    await fs.writeFile(path.join(tmp, "memory", "log.md"), bigLog());
    const res = await call(writeMemoryTool, { file: "log.md", content: "### new entry", mode: "append" });
    expect(res.isError).toBeUndefined();
    expect(text(res)).toContain("Appended");
    expect((await readLog()).startsWith("# Strength log")).toBe(true);
  });

  test("a non-append write that would shrink a long file is refused and leaves it untouched", async () => {
    const original = bigLog();
    await fs.writeFile(path.join(tmp, "memory", "log.md"), original);
    const res = await call(writeMemoryTool, { file: "log.md", content: "### new entry\n| squat | 95 × 5 |" });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("append: true");
    expect(await readLog()).toBe(original);
  });

  test("overwrite: true allows the intentional replace", async () => {
    await fs.writeFile(path.join(tmp, "memory", "log.md"), bigLog());
    const res = await call(writeMemoryTool, { file: "log.md", content: "fresh", overwrite: true });
    expect(res.isError).toBeUndefined();
    expect(await readLog()).toBe("fresh");
  });

  test("short files and new files are written without the guard", async () => {
    await fs.writeFile(path.join(tmp, "memory", "log.md"), "a\nb\nc");
    let res = await call(writeMemoryTool, { file: "log.md", content: "z" });
    expect(res.isError).toBeUndefined();
    expect(await readLog()).toBe("z");
    res = await call(writeMemoryTool, { file: "nested/new.md", content: "hello" });
    expect(res.isError).toBeUndefined();
    expect(text(res)).toContain("Created");
  });

  test("shrinkGuardError only fires on a >50% shrink of a file over the minimum size", () => {
    const long = Array.from({ length: 100 }, (_, i) => `l${i}`).join("\n");
    expect(shrinkGuardError(long, "x", "f")).not.toBeNull();
    expect(shrinkGuardError(long, long.slice(0, long.length / 2 + 10), "f")).toBeNull();
    expect(shrinkGuardError("a\nb\nc", "x", "f")).toBeNull();
  });
});

describe("read_memory — large files and ranges", () => {
  test("small files come back whole, unchanged", async () => {
    await fs.writeFile(path.join(tmp, "memory", "log.md"), "one\ntwo\nthree");
    const res = await call(readMemoryTool, { file: "log.md" });
    expect(text(res)).toBe("one\ntwo\nthree");
  });

  test("a file over the budget returns its tail, a header, and a heading index", async () => {
    const log = bigLog();
    expect(log.length).toBeGreaterThan(READ_MEMORY_CHAR_BUDGET);
    await fs.writeFile(path.join(tmp, "memory", "log.md"), log);
    const out = text(await call(readMemoryTool, { file: "log.md" }));
    expect(out.length).toBeLessThan(READ_MEMORY_CHAR_BUDGET + 6_000);
    expect(out).toContain("too large to return whole");
    expect(out).toContain("session 120");
    expect(out).toContain("Earlier headings");
    expect(out).toMatch(/^\[log\.md is \d+ lines/);
    // The index points at headings the tail does not include.
    expect(out).toMatch(/\n\d+: ## 2026-01-02 — session 1\n/);
  });

  test("offset/limit returns an exact line range with a position header", async () => {
    await fs.writeFile(path.join(tmp, "memory", "log.md"), bigLog());
    const out = text(await call(readMemoryTool, { file: "log.md", offset: 3, limit: 2 }));
    expect(out.split("\n")).toEqual([
      expect.stringMatching(/^\[log\.md: lines 3-4 of \d+\]$/),
      expect.stringContaining("session 1"),
      expect.stringContaining("| Lift 0 |"),
    ]);
  });

  test("sliceMemory never splits a line and clamps past the end", () => {
    const content = Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join("\n");
    expect(sliceMemory(content, "f", { offset: 9, limit: 50 })).toBe("[f: lines 9-10 of 10]\nline9\nline10");
  });
});
