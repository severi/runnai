import React from "react";
import { render } from "ink";
import * as fs from "fs/promises";
import * as path from "path";
import { execSync } from "child_process";
import { PROJECT_ROOT, getDataDir } from "../utils/paths.js";
import { getLogPath, logEvent } from "../utils/logger.js";
import App from "./App.js";

const DATA_SUBDIRS = [
  "athlete",
  "memory/race-predictions",
  "memory/session-summaries",
  "plans",
  "research/topics",
  "strava",
];

async function ensureDataDirs(): Promise<void> {
  const dataDir = getDataDir();
  await Promise.all(DATA_SUBDIRS.map(dir => fs.mkdir(path.join(dataDir, dir), { recursive: true })));
}

function isClaudeInstalled(): boolean {
  try {
    execSync("which claude", { stdio: "pipe", timeout: 1000 });
    return true;
  } catch {
    return false;
  }
}

export async function startCLI(): Promise<void> {
  // Auth: API key (pay-per-token) or Claude account via `claude login` (Pro/Max subscription)
  if (process.env.ANTHROPIC_API_KEY) {
    console.log("Auth: API key");
  } else if (isClaudeInstalled()) {
    console.log("Auth: Claude account");
  } else {
    console.error(
      "No authentication found. Either:\n" +
      "  1. Set ANTHROPIC_API_KEY in .env (API billing)\n" +
      "  2. Install Claude Code and run `claude login` (Pro/Max subscription)"
    );
    process.exit(1);
  }

  await ensureDataDirs();

  // Initialize session log and print path
  logEvent("session_start", {});
  const logDir = getLogPath();
  if (logDir) {
    const relative = path.relative(PROJECT_ROOT, logDir);
    console.log(`Session log: ${relative}/`);
  }

  const { waitUntilExit } = render(<App />, {
    // Ink 6.5+: only update changed lines, reduces flickering
    patchConsole: false,
    exitOnCtrlC: false, // We handle Ctrl+C ourselves (interrupt during processing, exit when idle)
  });
  await waitUntilExit();
}
