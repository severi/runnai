import * as fs from "fs";
import * as path from "path";
import { PROJECT_ROOT } from "./paths.js";

const LOGS_DIR = path.join(PROJECT_ROOT, "logs");

let sessionDir: string | null = null;
let eventsFd: number | null = null;
let toolResultsDir: string | null = null;

function ensureSessionDir(): string {
  if (sessionDir !== null) return sessionDir;

  fs.mkdirSync(LOGS_DIR, { recursive: true });

  const now = new Date();
  const timestamp = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  sessionDir = path.join(LOGS_DIR, `session-${timestamp}`);
  fs.mkdirSync(sessionDir, { recursive: true });

  toolResultsDir = path.join(sessionDir, "tool-results");
  fs.mkdirSync(toolResultsDir, { recursive: true });

  eventsFd = fs.openSync(path.join(sessionDir, "events.jsonl"), "a");

  // Write initial meta.json
  const meta = {
    started_at: now.toISOString(),
    auth: process.env.ANTHROPIC_API_KEY ? "api_key" : "claude_account",
    pid: process.pid,
    node_version: process.version,
  };
  fs.writeFileSync(path.join(sessionDir, "meta.json"), JSON.stringify(meta, null, 2));

  return sessionDir;
}

function ensureEventsFd(): number {
  ensureSessionDir();
  return eventsFd!;
}

export type LogEventType =
  | "session_start"
  | "session_resume"
  | "user_message"
  | "assistant_text"
  | "tool_use"
  | "tool_result"
  | "can_use_tool"
  | "subagent_start"
  | "subagent_stop"
  | "system_init"
  | "system_prompt"
  | "result"
  | "error"
  | "sdk_message";

interface BaseEvent {
  ts: string;
  type: LogEventType;
}

/** Log a structured event to events.jsonl */
export function logEvent(type: LogEventType, data: Record<string, unknown>): void {
  const fd = ensureEventsFd();
  const event: BaseEvent & Record<string, unknown> = {
    ts: new Date().toISOString(),
    type,
    ...data,
  };
  fs.writeSync(fd, JSON.stringify(event) + "\n");
}

/** Save a full tool result to a separate file if it's large. Returns the filename if saved, null if inlined. */
export function saveToolResult(toolUseId: string, result: unknown): string | null {
  ensureSessionDir();
  const str = typeof result === "string" ? result : JSON.stringify(result);
  if (str.length <= 1024) return null;

  const sanitizedId = toolUseId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const filename = `${sanitizedId}.json`;
  fs.writeFileSync(path.join(toolResultsDir!, filename), str);
  return filename;
}

/** Save the system prompt snapshot */
export function saveSystemPrompt(prompt: string): void {
  ensureSessionDir();
  fs.writeFileSync(path.join(sessionDir!, "system-prompt.md"), prompt);
}

/** Update meta.json with additional fields (e.g. session_id, model after init) */
export function updateMeta(updates: Record<string, unknown>): void {
  ensureSessionDir();
  const metaPath = path.join(sessionDir!, "meta.json");
  const existing = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
  fs.writeFileSync(metaPath, JSON.stringify({ ...existing, ...updates }, null, 2));
}

/** Get the session log directory path */
export function getLogPath(): string | null {
  return sessionDir;
}

/** Backwards-compatible log function — writes to events.jsonl as sdk_message type */
export function log(category: string, message: string, data?: unknown): void {
  logEvent("sdk_message", { category, message, ...(data !== undefined ? { data } : {}) });
}
