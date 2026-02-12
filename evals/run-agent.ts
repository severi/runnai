/**
 * Runs the RunnAI agent for a single eval prompt using the claude CLI.
 *
 * Reads config from env vars:
 *   RUNNAI_DATA_DIR  — path to fixture data directory
 *   RUNNAI_EVAL_MODEL — model to use (sonnet, opus)
 *   RUNNAI_EVAL_PROMPT — the user prompt to send
 *
 * Outputs JSON to stdout: { output: string, toolCalls: string[] }
 */
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import path from "path";
import { buildSystemPrompt } from "../src/utils/context-builder.js";

const PROJECT_ROOT = path.resolve(import.meta.dir, "..");
const prompt = process.env.RUNNAI_EVAL_PROMPT;
const model = process.env.RUNNAI_EVAL_MODEL || "sonnet";

if (!prompt) {
  console.error("RUNNAI_EVAL_PROMPT is required");
  process.exit(1);
}

// Build system prompt (reads CONTEXT.md from RUNNAI_DATA_DIR)
const systemPrompt = await buildSystemPrompt(PROJECT_ROOT);

// Write MCP config to temp file
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "runnai-eval-"));
const mcpConfigFile = path.join(tmpDir, "mcp-config.json");

const mcpConfig = {
  mcpServers: {
    runnai: {
      command: "bun",
      args: [path.join(PROJECT_ROOT, "evals/mcp-stdio-server.ts")],
      env: {
        RUNNAI_DATA_DIR: process.env.RUNNAI_DATA_DIR || "",
      },
    },
  },
};

fs.writeFileSync(mcpConfigFile, JSON.stringify(mcpConfig));

const allowedTools = [
  "mcp__runnai__query_activities",
  "mcp__runnai__read_memory",
  "mcp__runnai__search_memory",
  "mcp__runnai__best_efforts",
  "mcp__runnai__date_calc",
  "mcp__runnai__calculator",
  "mcp__runnai__manage_plan",
  "mcp__runnai__manage_personal_records",
  "mcp__runnai__get_hr_zones",
  "mcp__runnai__get_prediction_history",
].join(",");

try {
  const result = spawnSync("claude", [
    "--print",
    "--model", model,
    "--system-prompt", systemPrompt,
    "--output-format", "json",
    "--permission-mode", "bypassPermissions",
    "--dangerously-skip-permissions",
    "--max-turns", "15",
    "--no-session-persistence",
    "--mcp-config", mcpConfigFile,
    "--strict-mcp-config",
    "--allowed-tools", allowedTools,
  ], {
    input: prompt,
    encoding: "utf-8",
    timeout: 180000,
    maxBuffer: 10 * 1024 * 1024,
    env: process.env,
    cwd: PROJECT_ROOT,
  });

  if (result.error) {
    throw result.error;
  }

  const stdout = result.stdout || "";
  const stderr = result.stderr || "";

  if (result.status !== 0 && stderr) {
    console.error("Claude CLI stderr:", stderr.slice(0, 500));
  }

  // Parse JSON output from claude --output-format json
  try {
    const parsed = JSON.parse(stdout.trim());
    const output = parsed.result || "";
    console.log(JSON.stringify({ output, toolCalls: [] }));
  } catch {
    // If not JSON, use raw output
    console.log(JSON.stringify({ output: stdout.trim(), toolCalls: [] }));
  }
} catch (error: any) {
  console.error("Agent execution failed:", error.message);
  console.log(JSON.stringify({ output: "Error: Agent execution failed", toolCalls: [] }));
  process.exit(1);
} finally {
  try {
    fs.unlinkSync(mcpConfigFile);
    fs.rmdirSync(tmpDir);
  } catch {}
}
