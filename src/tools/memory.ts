import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import * as fs from "fs/promises";
import * as path from "path";
import { getDataDir } from "../utils/paths.js";
import { toDateString, toolResult, toolError } from "../utils/format.js";
import { withDiffNote } from "../utils/data-git.js";
import { replaceContextSection, looksLikePartialContext, countContextSections } from "../utils/context-md.js";

function getMemoryDir(): string {
  return path.join(getDataDir(), "memory");
}

function getContextFile(): string {
  return path.join(getDataDir(), "athlete/CONTEXT.md");
}

function isPathSafe(filePath: string): boolean {
  const resolved = path.resolve(getMemoryDir(), filePath);
  return resolved.startsWith(getMemoryDir());
}

/**
 * Largest read_memory result returned whole. The CLI caps MCP tool results
 * (MAX_MCP_OUTPUT_TOKENS); past the cap the result is spilled to a file and
 * the agent has to grep it back in. Long dated logs (strength, injuries)
 * blow through that, so above this budget the tool returns the TAIL of the
 * file plus a heading index, which is what a log read nearly always wants.
 */
export const READ_MEMORY_CHAR_BUDGET = 40_000;

/** Line numbers (1-based) of every `## ` / `### ` heading, for jumping with offset. */
export function headingIndex(lines: string[]): string {
  const out: string[] = [];
  lines.forEach((line, i) => {
    if (/^#{1,3} /.test(line)) out.push(`${i + 1}: ${line.trim()}`);
  });
  return out.join("\n");
}

export function sliceMemory(
  content: string,
  file: string,
  opts: { offset?: number; limit?: number },
): string {
  const lines = content.split("\n");
  const total = lines.length;

  if (opts.offset !== undefined || opts.limit !== undefined) {
    const start = Math.max(1, opts.offset ?? 1);
    const end = opts.limit !== undefined ? Math.min(total, start + opts.limit - 1) : total;
    const slice = lines.slice(start - 1, end).join("\n");
    return `[${file}: lines ${start}-${end} of ${total}]\n${slice}`;
  }

  if (content.length <= READ_MEMORY_CHAR_BUDGET) return content;

  // Whole-line tail that fits the budget.
  let chars = 0;
  let start = total;
  while (start > 1 && chars + lines[start - 2].length + 1 <= READ_MEMORY_CHAR_BUDGET) {
    start -= 1;
    chars += lines[start - 1].length + 1;
  }
  const tail = lines.slice(start - 1).join("\n");
  const index = headingIndex(lines.slice(0, start - 1));
  return [
    `[${file} is ${total} lines / ${content.length} chars — too large to return whole. Showing lines ${start}-${total} (the most recent part). Use offset/limit to read earlier sections.]`,
    index ? `\nEarlier headings (line: heading):\n${index}\n` : "",
    tail,
  ].join("\n");
}

export const readMemoryTool = tool(
  "read_memory",
  "Read a file from the deep memory directory (data/memory/). Use this to recall observations, training history, injury logs, or session summaries. Large files (long dated logs) return the most recent part plus a heading index; pass offset/limit to read a specific range.",
  {
    file: z.string().describe("File path relative to data/memory/ (e.g., 'observations.md', 'race-predictions/marathon.md')"),
    offset: z.number().int().positive().optional().describe("1-based line to start from (use with the heading index a large read returns)"),
    limit: z.number().int().positive().optional().describe("Max lines to return from offset"),
  },
  async ({ file, offset, limit }) => {
    try {
      if (!isPathSafe(file)) {
        return toolResult("Error: Path traversal not allowed.", true);
      }

      const filePath = path.join(getMemoryDir(), file);
      const content = await fs.readFile(filePath, "utf-8");
      return toolResult(sliceMemory(content, file, { offset, limit }));
    } catch {
      return toolResult(`Memory file '${file}' not found or empty.`);
    }
  }
);

/**
 * Refuse a non-append write that would throw away most of an existing file.
 * Nov 2026: a call sent `mode: "append"` (not in the schema) was stripped by
 * zod, ran as a full overwrite, reported success, and cut the strength log
 * from 993 lines to 13. Returns the error text, or null when the write is fine.
 */
export const SHRINK_GUARD_MIN_LINES = 20;
export function shrinkGuardError(existing: string, content: string, file: string): string | null {
  const before = existing.split("\n").length;
  const after = content.split("\n").length;
  if (before < SHRINK_GUARD_MIN_LINES || after * 2 >= before) return null;
  return `Error: refusing to overwrite ${file} — it has ${before} lines and the new content has ${after}, so this would erase most of the file. Pass append: true to add to the end, or overwrite: true if you really mean to replace the whole file.`;
}

export const writeMemoryTool = tool(
  "write_memory",
  "Write or append to a memory file in data/memory/. Use this to record observations, update training history, or log injuries. Dated logs: ALWAYS pass append: true — without it the file is REPLACED. A replace that would shrink an existing file by more than half is refused unless overwrite: true.",
  {
    file: z.string().describe("File path relative to data/memory/"),
    content: z.string().describe("Content to write"),
    append: z.boolean().optional().describe("true = append to the existing file (what dated logs want). Default: false (replace the whole file)"),
    mode: z.enum(["append", "overwrite"]).optional().describe("Alias for append: 'append' is append: true, 'overwrite' is append: false"),
    overwrite: z.boolean().optional().describe("Confirm a full replace that shrinks an existing file by more than half"),
  },
  async ({ file, content, append, mode, overwrite = false }) => {
    try {
      if (!isPathSafe(file)) {
        return toolResult("Error: Path traversal not allowed.", true);
      }
      const doAppend = append ?? (mode === "append");

      const filePath = path.join(getMemoryDir(), file);
      await fs.mkdir(path.dirname(filePath), { recursive: true });

      let existing: string | null = null;
      try {
        existing = await fs.readFile(filePath, "utf-8");
      } catch {
        // File doesn't exist yet
      }

      if (doAppend) {
        await fs.writeFile(filePath, (existing ?? "") + "\n" + content);
        return toolResult(await withDiffNote(`Appended to memory file: ${file}`));
      }

      if (existing !== null && !overwrite) {
        const err = shrinkGuardError(existing, content, file);
        if (err) return toolResult(err, true);
      }
      await fs.writeFile(filePath, content);
      const what = existing === null ? "Created" : "Replaced";
      return toolResult(await withDiffNote(`${what} memory file: ${file}`));
    } catch (error) {
      return toolError(error);
    }
  }
);

export const updateContextTool = tool(
  "update_context",
  "Update the hot cache (data/athlete/CONTEXT.md). Preferred: pass `section` to replace ONE `## Section` block, preserving the rest. WITHOUT `section`, `content` REPLACES THE ENTIRE FILE — only do that with the complete updated file. Always in the system prompt; keep it under 100 lines.",
  {
    content: z.string().describe("The section's new body (when `section` is given), or the COMPLETE new CONTEXT.md (when omitted — everything not in `content` is erased)"),
    section: z.string().optional().describe("Heading of the `## Section` to replace (e.g. 'Current Training Plan'). All other sections are preserved."),
  },
  async ({ content, section }) => {
    try {
      let existing = "";
      try {
        existing = await fs.readFile(getContextFile(), "utf-8");
      } catch {
        // No existing file — any write is a full write
      }

      let next = content;
      if (section) {
        const res = replaceContextSection(existing, section, content);
        if (!res.ok) {
          return toolResult(`Error: ${res.error}`, true);
        }
        next = res.result;
      } else if (existing && looksLikePartialContext(existing, content)) {
        // The exact failure that wiped the hot cache once: a single section's
        // body sent as a full-file replace. Refuse instead of erasing.
        return toolResult(
          `Error: content has ${countContextSections(content)} \`## \` section(s) but the existing CONTEXT.md has ${countContextSections(existing)} — writing this would ERASE the rest of the file. Pass section: "<heading>" to update one section, or provide the complete updated file.`,
          true,
        );
      }

      const lines = next.split("\n").length;
      if (lines > 100) {
        return toolResult(`Error: CONTEXT.md must be under 100 lines (got ${lines}). Move details to deep memory files.`, true);
      }

      await fs.writeFile(getContextFile(), next);
      const what = section ? `section "${section}", now ${lines} lines total` : `${lines} lines`;
      return toolResult(await withDiffNote(`Updated CONTEXT.md (${what}). Changes will be reflected in the next message.`));
    } catch (error) {
      return toolError(error);
    }
  }
);

export const searchMemoryTool = tool(
  "search_memory",
  "Search across all memory files for relevant content. Simple string search.",
  {
    query: z.string().describe("Search term to find in memory files"),
  },
  async ({ query }) => {
    try {
      const results: Array<{ file: string; matches: string[] }> = [];

      async function searchDir(dir: string, prefix: string): Promise<void> {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        const lowerQuery = query.toLowerCase();

        const tasks = entries.map(async (entry) => {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            await searchDir(fullPath, `${prefix}${entry.name}/`);
          } else if (entry.name.endsWith(".md")) {
            const content = await fs.readFile(fullPath, "utf-8");
            const lowerContent = content.toLowerCase();

            if (lowerContent.includes(lowerQuery)) {
              const lines = content.split("\n");
              const matches: string[] = [];
              for (let i = 0; i < lines.length; i++) {
                if (lines[i].toLowerCase().includes(lowerQuery)) {
                  const start = Math.max(0, i - 1);
                  const end = Math.min(lines.length, i + 2);
                  matches.push(lines.slice(start, end).join("\n"));
                }
              }
              results.push({ file: `${prefix}${entry.name}`, matches });
            }
          }
        });
        await Promise.all(tasks);
      }

      await searchDir(getMemoryDir(), "");

      if (results.length === 0) {
        return toolResult(`No matches found for "${query}" in memory files.`);
      }

      let output = `**Search results for "${query}":**\n\n`;
      for (const result of results) {
        output += `### ${result.file}\n`;
        for (const match of result.matches) {
          output += `\`\`\`\n${match}\n\`\`\`\n`;
        }
        output += "\n";
      }

      return toolResult(output);
    } catch (error) {
      return toolError(error);
    }
  }
);

export const saveSessionSummaryTool = tool(
  "save_session_summary",
  "Write a dated session summary to data/memory/session-summaries/. Call at the end of significant conversations.",
  {
    summary: z.string().describe("Summary of key topics, decisions, and learnings from this session"),
  },
  async ({ summary }) => {
    try {
      const date = toDateString();
      const dir = path.join(getMemoryDir(), "session-summaries");
      await fs.mkdir(dir, { recursive: true });

      const filePath = path.join(dir, `${date}.md`);

      // Append if file for today already exists
      let existing = "";
      try {
        existing = await fs.readFile(filePath, "utf-8");
        existing += "\n---\n\n";
      } catch {
        // New file for today
      }

      const content = `${existing}# Session Summary - ${date}\n\n${summary}\n`;
      await fs.writeFile(filePath, content);

      return toolResult(await withDiffNote(`Session summary saved to session-summaries/${date}.md`));
    } catch (error) {
      return toolError(error);
    }
  }
);
