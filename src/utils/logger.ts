import * as fs from "fs";
import * as path from "path";
import { PROJECT_ROOT } from "./paths.js";

const LOGS_DIR = path.join(PROJECT_ROOT, "logs");

let logFd: number | null = null;
let logPath: string | null = null;

function ensureLogFile(): number {
  if (logFd !== null) return logFd;

  fs.mkdirSync(LOGS_DIR, { recursive: true });

  const now = new Date();
  const timestamp = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  logPath = path.join(LOGS_DIR, `session-${timestamp}.log`);
  logFd = fs.openSync(logPath, "a");

  return logFd;
}

function ts(): string {
  return new Date().toISOString();
}

export function log(category: string, message: string, data?: unknown): void {
  const fd = ensureLogFile();
  let line = `${ts()} [${category}] ${message}`;
  if (data !== undefined) {
    const str = typeof data === "string" ? data : JSON.stringify(data);
    line += ` ${str}`;
  }
  fs.writeSync(fd, line + "\n");
}

export function getLogPath(): string | null {
  return logPath;
}
