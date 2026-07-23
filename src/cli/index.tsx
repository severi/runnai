import React from "react";
import { render } from "ink";
import * as fs from "fs/promises";
import * as path from "path";
import { execSync } from "child_process";
import { PROJECT_ROOT, getDataDir } from "../utils/paths.js";
import { getLogPath, logEvent } from "../utils/logger.js";
import { ensureDataRepo, registerCrashHandlers, commitOnClose } from "../utils/data-git.js";
import { getAuthStatus } from "../utils/claude-auth.js";
import * as os from "os";
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
  // Auth: API key (pay-per-token) or Claude account via `claude auth login` (Pro/Max subscription)
  if (process.env.ANTHROPIC_API_KEY) {
    console.log("Auth: API key");
  } else if (isClaudeInstalled()) {
    const status = await getAuthStatus();
    if (status?.loggedIn) {
      console.log(`Auth: Claude account${status.email ? ` (${status.email})` : ""}`);
    } else {
      console.log("Not logged in — type /login in the session to authenticate.");
    }
  } else {
    console.error(
      "No authentication found. Either:\n" +
      "  1. Set ANTHROPIC_API_KEY in .env (API billing)\n" +
      "  2. Install Claude Code and run `claude auth login` (Pro/Max subscription)"
    );
    process.exit(1);
  }

  await ensureDataDirs();
  await ensureDataRepo();
  registerCrashHandlers();

  // Initialize session log and print path
  logEvent("system", {
    subtype: "session_start",
    auth: process.env.ANTHROPIC_API_KEY ? "api_key" : "claude_account",
    pid: process.pid,
    nodeVersion: process.version,
    platform: os.platform(),
  });
  const logFile = getLogPath();
  if (logFile) {
    const relative = path.relative(PROJECT_ROOT, logFile);
    console.log(`Session log: ${relative}`);
  }

  // Scroll policy hint (xterm/rxvt mode 1010): ask the emulator NOT to jump
  // to the bottom when output arrives — so a user who has scrolled up stays
  // put while the coach streams, and the viewport still follows naturally
  // when they're already at the bottom. The follow/stay decision lives in
  // the emulator (apps can't query scroll position); this just requests the
  // right policy. Unsupported terminals ignore it harmlessly.
  process.stdout.write("\x1b[?1010l");

  const resume = process.argv.includes("--resume");

  const { waitUntilExit } = render(<App resume={resume} />, {
    // Ink 6.5+: only update changed lines, reduces flickering
    patchConsole: false,
    exitOnCtrlC: false, // We handle Ctrl+C ourselves (interrupt during processing, exit when idle)
    // Kitty keyboard protocol — lets supporting terminals send distinct
    // sequences for modified keys (e.g. Shift+Enter → \x1b[13;2u), so we
    // can detect key.shift + key.return. Unsupported terminals ignore the
    // enable sequence harmlessly.
    kittyKeyboard: { mode: "enabled", flags: ["disambiguateEscapeCodes"] },
  });
  await waitUntilExit();
  // Restore default scroll-on-output policy for the user's shell session
  process.stdout.write("\x1b[?1010h");
  await commitOnClose("session end: auto-backup");
}
