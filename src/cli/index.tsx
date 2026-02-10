import React from "react";
import { render } from "ink";
import * as fs from "fs/promises";
import * as path from "path";
import { execFileSync } from "child_process";
import { PROJECT_ROOT } from "../agent.js";
import App from "./App.js";

const DATA_DIRS = [
  "data/athlete",
  "data/memory/race-predictions",
  "data/memory/session-summaries",
  "data/plans",
  "data/research/topics",
  "data/strava",
];

async function ensureDataDirs(): Promise<void> {
  for (const dir of DATA_DIRS) {
    await fs.mkdir(path.join(PROJECT_ROOT, dir), { recursive: true });
  }
}

function isClaudeInstalled(): boolean {
  try {
    execFileSync("claude", ["--version"], { timeout: 5000, stdio: "pipe" });
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

  const resumeFlag = process.argv.includes("--resume");

  await ensureDataDirs();

  const { waitUntilExit } = render(<App resume={resumeFlag} />);
  await waitUntilExit();
}
