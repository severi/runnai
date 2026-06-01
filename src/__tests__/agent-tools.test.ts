import { describe, test, expect } from "bun:test";
import { agents } from "../agent.js";

// Built-in (non-MCP) tools that are correctly referenced by bare name in a
// subagent `tools` allowlist. Everything else must be an MCP tool, which the
// SDK only resolves by its fully-qualified `mcp__<server>__<tool>` name —
// bare MCP names silently match nothing once tool-search/deferral is active,
// which left every subagent with zero MCP tools (the reviewer "couldn't reach
// the tools" bug). This guard keeps the allowlists qualified.
const BUILTIN_TOOLS = new Set([
  "Read", "Write", "Edit", "Bash", "Glob", "Grep",
  "WebSearch", "WebFetch", "Task", "Skill", "ToolSearch",
]);

const MCP_PREFIX = "mcp__runnai__";

describe("subagent tool allowlists", () => {
  for (const [name, def] of Object.entries(agents)) {
    test(`${name}: every non-builtin tool is MCP-qualified`, () => {
      for (const tool of def.tools ?? []) {
        if (BUILTIN_TOOLS.has(tool)) continue;
        expect(
          tool.startsWith(MCP_PREFIX),
          `Agent "${name}" lists tool "${tool}" by bare name — MCP tools must be "${MCP_PREFIX}${tool}"`
        ).toBe(true);
      }
    });
  }
});
