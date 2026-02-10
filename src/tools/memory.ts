import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import * as fs from "fs/promises";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "../..");
const MEMORY_DIR = path.join(PROJECT_ROOT, "data/memory");
const CONTEXT_FILE = path.join(PROJECT_ROOT, "data/athlete/CONTEXT.md");

function isPathSafe(filePath: string): boolean {
  const resolved = path.resolve(MEMORY_DIR, filePath);
  return resolved.startsWith(MEMORY_DIR);
}

export const readMemoryTool = tool(
  "read_memory",
  "Read a file from the deep memory directory (data/memory/). Use this to recall observations, training history, injury logs, or session summaries.",
  {
    file: z.string().describe("File path relative to data/memory/ (e.g., 'observations.md', 'race-predictions/marathon.md')"),
  },
  async ({ file }) => {
    try {
      if (!isPathSafe(file)) {
        return { content: [{ type: "text" as const, text: "Error: Path traversal not allowed." }], isError: true };
      }

      const filePath = path.join(MEMORY_DIR, file);
      const content = await fs.readFile(filePath, "utf-8");
      return { content: [{ type: "text" as const, text: content }] };
    } catch {
      return { content: [{ type: "text" as const, text: `Memory file '${file}' not found or empty.` }] };
    }
  }
);

export const writeMemoryTool = tool(
  "write_memory",
  "Write or append to a memory file in data/memory/. Use this to record observations, update training history, or log injuries.",
  {
    file: z.string().describe("File path relative to data/memory/"),
    content: z.string().describe("Content to write"),
    append: z.boolean().optional().describe("If true, append to existing file. Default: false (overwrite)"),
  },
  async ({ file, content, append = false }) => {
    try {
      if (!isPathSafe(file)) {
        return { content: [{ type: "text" as const, text: "Error: Path traversal not allowed." }], isError: true };
      }

      const filePath = path.join(MEMORY_DIR, file);
      await fs.mkdir(path.dirname(filePath), { recursive: true });

      if (append) {
        let existing = "";
        try {
          existing = await fs.readFile(filePath, "utf-8");
        } catch {
          // File doesn't exist yet
        }
        await fs.writeFile(filePath, existing + "\n" + content);
      } else {
        await fs.writeFile(filePath, content);
      }

      return { content: [{ type: "text" as const, text: `Updated memory file: ${file}` }] };
    } catch (error) {
      return {
        content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  }
);

export const updateContextTool = tool(
  "update_context",
  "Update the hot cache (data/athlete/CONTEXT.md). This is always loaded into the system prompt, so keep it concise (<100 lines).",
  {
    content: z.string().describe("New CONTEXT.md content (must be under 100 lines)"),
  },
  async ({ content }) => {
    try {
      const lines = content.split("\n").length;
      if (lines > 100) {
        return {
          content: [{
            type: "text" as const,
            text: `Error: CONTEXT.md must be under 100 lines (got ${lines}). Move details to deep memory files.`,
          }],
          isError: true,
        };
      }

      await fs.writeFile(CONTEXT_FILE, content);
      return { content: [{ type: "text" as const, text: `Updated CONTEXT.md (${lines} lines). Changes will be reflected in the next message.` }] };
    } catch (error) {
      return {
        content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
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
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            await searchDir(fullPath, `${prefix}${entry.name}/`);
          } else if (entry.name.endsWith(".md")) {
            const content = await fs.readFile(fullPath, "utf-8");
            const lowerContent = content.toLowerCase();
            const lowerQuery = query.toLowerCase();

            if (lowerContent.includes(lowerQuery)) {
              // Extract matching lines with context
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
        }
      }

      await searchDir(MEMORY_DIR, "");

      if (results.length === 0) {
        return { content: [{ type: "text" as const, text: `No matches found for "${query}" in memory files.` }] };
      }

      let output = `**Search results for "${query}":**\n\n`;
      for (const result of results) {
        output += `### ${result.file}\n`;
        for (const match of result.matches) {
          output += `\`\`\`\n${match}\n\`\`\`\n`;
        }
        output += "\n";
      }

      return { content: [{ type: "text" as const, text: output }] };
    } catch (error) {
      return {
        content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
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
      const date = new Date().toISOString().split("T")[0];
      const dir = path.join(MEMORY_DIR, "session-summaries");
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

      return { content: [{ type: "text" as const, text: `Session summary saved to session-summaries/${date}.md` }] };
    } catch (error) {
      return {
        content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  }
);
