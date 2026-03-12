import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";
import { PROJECT_ROOT } from "./paths.js";

const LOGS_DIR = path.join(PROJECT_ROOT, "logs");

// Read version once at import time
let appVersion = "unknown";
try {
  const pkg = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, "package.json"), "utf-8"));
  appVersion = pkg.version;
} catch {}

let logFilePath: string | null = null;
let eventsFd: number | null = null;
let sessionId: string = `temp-${Date.now()}`;

function ensureLogFile(): number {
  if (eventsFd !== null) return eventsFd;

  fs.mkdirSync(LOGS_DIR, { recursive: true });
  logFilePath = path.join(LOGS_DIR, `${sessionId}.jsonl`);
  eventsFd = fs.openSync(logFilePath, "a");

  return eventsFd;
}

export type LogEventType = "user" | "assistant" | "system" | "progress";
export type LogEventSubtype =
  | "session_start" | "init" | "system_prompt" | "can_use_tool"
  | "turn_duration" | "result" | "error";

/** Log a structured event to the session JSONL file. Returns the event UUID. */
export function logEvent(
  type: LogEventType,
  data: Record<string, unknown> & { subtype?: LogEventSubtype },
  parentUuid?: string | null,
): string {
  const fd = ensureLogFile();
  const uuid = randomUUID();
  const event = {
    type,
    uuid,
    parentUuid: parentUuid ?? null,
    sessionId,
    version: appVersion,
    timestamp: new Date().toISOString(),
    ...data,
  };
  fs.writeSync(fd, JSON.stringify(event) + "\n");
  return uuid;
}

/** Update the session ID (called when SDK provides the real session UUID). Renames the log file. */
export function setLogSessionId(id: string): void {
  const oldPath = logFilePath;
  const oldFd = eventsFd;
  sessionId = id;

  if (oldPath && oldFd !== null) {
    // Close old fd, rename file, reopen
    fs.closeSync(oldFd);
    const newPath = path.join(LOGS_DIR, `${id}.jsonl`);
    fs.renameSync(oldPath, newPath);
    logFilePath = newPath;
    eventsFd = fs.openSync(newPath, "a");
  }
}

/** Get the session log file path */
export function getLogPath(): string | null {
  return logFilePath;
}
