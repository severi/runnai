/**
 * Standalone MCP stdio server for evals.
 *
 * Exposes read-only coaching tools over stdio. Spawned by the claude CLI
 * via --mcp-config. Reads RUNNAI_DATA_DIR to find fixture data.
 *
 * Excludes tools that hit external APIs (Strava sync/auth, weather, research).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { queryActivities } from "../src/utils/activities-db.js";
import {
  getBestEfforts,
  getStravaBestEfforts,
  getPersonalRecords,
} from "../src/utils/activities-db.js";
import { loadHrZones } from "../src/utils/hr-zones.js";
import { getPredictionHistory } from "../src/utils/activities-db.js";
import { evaluate } from "mathjs";

import * as fs from "fs/promises";
import * as path from "path";
import { getDataDir } from "../src/utils/paths.js";

const server = new McpServer({
  name: "runnai-eval",
  version: "1.0.0",
});

// query_activities — SQL queries against the fixture DB
server.tool(
  "query_activities",
  "Run a SQL SELECT query against the activities database.",
  { query: z.string().describe("SQL SELECT query") },
  async ({ query }) => {
    try {
      const results = queryActivities(query);
      return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
    } catch (error: any) {
      return { content: [{ type: "text", text: `Query error: ${error.message}` }], isError: true };
    }
  },
);

// read_memory — read memory files
server.tool(
  "read_memory",
  "Read a file from the deep memory directory.",
  { file: z.string().describe("File path relative to memory/") },
  async ({ file }) => {
    try {
      const memoryDir = path.join(getDataDir(), "memory");
      const resolved = path.resolve(memoryDir, file);
      if (!resolved.startsWith(memoryDir)) {
        return { content: [{ type: "text", text: "Path traversal not allowed." }], isError: true };
      }
      const content = await fs.readFile(resolved, "utf-8");
      return { content: [{ type: "text", text: content }] };
    } catch {
      return { content: [{ type: "text", text: `Memory file '${file}' not found.` }] };
    }
  },
);

// search_memory — search across memory files
server.tool(
  "search_memory",
  "Search across all memory files for relevant content.",
  { query: z.string().describe("Search term") },
  async ({ query }) => {
    try {
      const memoryDir = path.join(getDataDir(), "memory");
      const results: Array<{ file: string; matches: string[] }> = [];

      async function searchDir(dir: string, prefix: string): Promise<void> {
        let entries;
        try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            await searchDir(fullPath, `${prefix}${entry.name}/`);
          } else if (entry.name.endsWith(".md")) {
            const content = await fs.readFile(fullPath, "utf-8");
            if (content.toLowerCase().includes(query.toLowerCase())) {
              const lines = content.split("\n");
              const matches: string[] = [];
              for (let i = 0; i < lines.length; i++) {
                if (lines[i].toLowerCase().includes(query.toLowerCase())) {
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

      await searchDir(memoryDir, "");

      if (results.length === 0) {
        return { content: [{ type: "text", text: `No matches for "${query}".` }] };
      }

      let output = `Search results for "${query}":\n\n`;
      for (const r of results) {
        output += `### ${r.file}\n`;
        for (const m of r.matches) output += `\`\`\`\n${m}\n\`\`\`\n`;
        output += "\n";
      }
      return { content: [{ type: "text", text: output }] };
    } catch (error: any) {
      return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
    }
  },
);

// best_efforts — get best effort data
server.tool(
  "best_efforts",
  "Get best efforts (PRs) for standard distances.",
  { distance: z.string().optional().describe("Distance name (e.g. '5K', '10K', 'Half-Marathon')") },
  async ({ distance }) => {
    try {
      const stravaBests = getStravaBestEfforts(distance);
      const computedBests = getBestEfforts(distance);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ strava: stravaBests, computed: computedBests }, null, 2),
        }],
      };
    } catch (error: any) {
      return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
    }
  },
);

// date_calc — date arithmetic
server.tool(
  "date_calc",
  "Calculate date differences and arithmetic.",
  {
    date: z.string().describe("Start date (YYYY-MM-DD)"),
    operation: z.enum(["add", "subtract", "diff"]).describe("Operation"),
    days: z.number().optional().describe("Days to add/subtract"),
    target_date: z.string().optional().describe("Target date for diff"),
  },
  async ({ date, operation, days, target_date }) => {
    try {
      const d = new Date(date + "T00:00:00");
      if (isNaN(d.getTime())) {
        return { content: [{ type: "text", text: "Invalid date format" }], isError: true };
      }

      if (operation === "diff") {
        if (!target_date) {
          return { content: [{ type: "text", text: "target_date required for diff" }], isError: true };
        }
        const t = new Date(target_date + "T00:00:00");
        const diffDays = Math.round((t.getTime() - d.getTime()) / (1000 * 60 * 60 * 24));
        const weeks = Math.floor(Math.abs(diffDays) / 7);
        return {
          content: [{
            type: "text",
            text: `${Math.abs(diffDays)} days (${weeks} weeks, ${Math.abs(diffDays) % 7} days)`,
          }],
        };
      }

      const result = new Date(d);
      const offset = days || 0;
      result.setDate(result.getDate() + (operation === "add" ? offset : -offset));
      return {
        content: [{ type: "text", text: result.toISOString().split("T")[0] }],
      };
    } catch (error: any) {
      return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
    }
  },
);

// calculator — math expressions
server.tool(
  "calculator",
  "Evaluate a math expression.",
  { expression: z.string().describe("Math expression (e.g. '6*60+30' for 6:30 pace)") },
  async ({ expression }) => {
    try {
      const result = evaluate(expression);
      return { content: [{ type: "text", text: String(result) }] };
    } catch (error: any) {
      return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
    }
  },
);

// manage_plan — read-only plan access for evals
server.tool(
  "manage_plan",
  "Read training plans.",
  {
    action: z.enum(["get", "list"]).describe("Action: get or list"),
    plan_name: z.string().optional().describe("Plan filename"),
  },
  async ({ action, plan_name }) => {
    try {
      const plansDir = path.join(getDataDir(), "plans");

      if (action === "list") {
        let files: string[];
        try { files = await fs.readdir(plansDir); } catch { files = []; }
        const plans = files.filter(f => f.endsWith(".md"));
        if (plans.length === 0) return { content: [{ type: "text", text: "No plans found." }] };
        return { content: [{ type: "text", text: `Plans:\n${plans.map(p => `- ${p}`).join("\n")}` }] };
      }

      if (action === "get" && plan_name) {
        const content = await fs.readFile(path.join(plansDir, plan_name), "utf-8");
        return { content: [{ type: "text", text: content }] };
      }

      return { content: [{ type: "text", text: "Specify action and plan_name." }], isError: true };
    } catch (error: any) {
      return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
    }
  },
);

// manage_personal_records — read-only PR access
server.tool(
  "manage_personal_records",
  "Get personal records.",
  {
    action: z.enum(["get"]).describe("Action: get"),
    distance: z.string().optional().describe("Distance name"),
  },
  async ({ distance }) => {
    try {
      const records = getPersonalRecords(distance);
      if (records.length === 0) return { content: [{ type: "text", text: "No personal records found." }] };
      return { content: [{ type: "text", text: JSON.stringify(records, null, 2) }] };
    } catch (error: any) {
      return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
    }
  },
);

// get_hr_zones — read HR zones
server.tool(
  "get_hr_zones",
  "Get the athlete's heart rate zones.",
  {},
  async () => {
    try {
      const zones = await loadHrZones();
      return { content: [{ type: "text", text: JSON.stringify(zones, null, 2) }] };
    } catch (error: any) {
      return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
    }
  },
);

// get_prediction_history — race prediction history
server.tool(
  "get_prediction_history",
  "Get race time prediction history.",
  { distance: z.string().optional().describe("Race distance") },
  async ({ distance }) => {
    try {
      const predictions = getPredictionHistory(distance);
      if (predictions.length === 0) return { content: [{ type: "text", text: "No predictions found." }] };
      return { content: [{ type: "text", text: JSON.stringify(predictions, null, 2) }] };
    } catch (error: any) {
      return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
    }
  },
);

// Start stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
