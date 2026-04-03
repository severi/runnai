import { spawnSync } from "child_process";
import { getDataDir } from "./paths.js";

let _repoReady = false;
let _gitAvailable: boolean | null = null;

// Serialize all async git operations to prevent index.lock races
// when multiple tools call diffSummary/commitData concurrently.
let _gitQueue: Promise<void> = Promise.resolve();

function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const result = _gitQueue.then(fn);
  _gitQueue = result.then(() => {}, () => {});
  return result;
}

interface GitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function gitSync(args: string[]): GitResult {
  const result = spawnSync("git", args, {
    cwd: getDataDir(),
    encoding: "utf-8",
    timeout: 10_000,
  });

  if (result.error) {
    if ((result.error as NodeJS.ErrnoException).code === "ENOENT") {
      _gitAvailable = false;
      return { stdout: "", stderr: "git not found", exitCode: 1 };
    }
    return { stdout: "", stderr: result.error.message, exitCode: 1 };
  }

  if (_gitAvailable === null) _gitAvailable = true;
  return {
    stdout: result.stdout?.trim() ?? "",
    stderr: result.stderr?.trim() ?? "",
    exitCode: result.status ?? 1,
  };
}

async function git(args: string[]): Promise<GitResult> {
  if (_gitAvailable === false) {
    return { stdout: "", stderr: "git not available", exitCode: 1 };
  }

  try {
    const proc = Bun.spawn(["git", ...args], {
      cwd: getDataDir(),
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;

    if (_gitAvailable === null) _gitAvailable = true;
    return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      _gitAvailable = false;
    }
    return { stdout: "", stderr: String(e), exitCode: 1 };
  }
}

/** Get staged diff summary (stage all first). Always has commits after ensureDataRepo. */
async function getStagedDiff(): Promise<string> {
  await git(["add", "-A"]);
  const result = await git(["diff", "--stat", "HEAD"]);
  return result.exitCode === 0 ? result.stdout : "";
}

export async function ensureDataRepo(): Promise<void> {
  if (_repoReady) return;

  const init = await git(["init"]);
  if (init.exitCode !== 0) {
    if (_gitAvailable === false) {
      console.warn("Warning: git not found — data backup disabled.");
    }
    return;
  }

  // Set local identity so commits work even without global git config
  await git(["config", "user.email", "runnai@local"]);
  await git(["config", "user.name", "RunnAI"]);

  // Initial commit if repo is empty
  const head = await git(["rev-parse", "HEAD"]);
  if (head.exitCode !== 0) {
    await git(["add", "-A"]);
    const result = await git(["commit", "-m", "initial data snapshot", "--allow-empty"]);
    if (result.exitCode === 0) {
      console.log("Data backup: initialized git repo in data/");
    }
  }

  _repoReady = true;
}

/** Stage all changes and return diff summary. Serialized via queue. */
export function diffSummary(): Promise<string> {
  return enqueue(async () => {
    if (!_repoReady) return "";
    return getStagedDiff();
  });
}

/** Append diff summary to a tool result message. */
export async function withDiffNote(message: string): Promise<string> {
  const diff = await diffSummary();
  return diff ? `${message}\n\nGit diff:\n${diff}` : message;
}

/** Commit staged and unstaged data changes. Serialized via queue. */
export function commitData(message: string): Promise<{ committed: boolean; summary: string; sha?: string; error?: string }> {
  return enqueue(async () => {
    if (!_repoReady) {
      return { committed: false, summary: "", error: "data git repo not initialized" };
    }

    await git(["add", "-A"]);

    const status = await git(["status", "--porcelain"]);
    if (!status.stdout) {
      return { committed: false, summary: "nothing to commit" };
    }

    const diff = await git(["diff", "--stat", "HEAD"]);
    const summary = diff.exitCode === 0 ? diff.stdout : "";

    const result = await git(["commit", "-m", message]);
    if (result.exitCode !== 0) {
      return { committed: false, summary, error: result.stderr };
    }

    const sha = await git(["rev-parse", "--short", "HEAD"]);
    return { committed: true, summary, sha: sha.stdout };
  });
}

/** Best-effort commit on session close. Serialized via queue. */
export function commitOnClose(message = "session end: auto-backup"): Promise<void> {
  if (!_repoReady) return Promise.resolve();

  return enqueue(async () => {
    try {
      await git(["add", "-A"]);
      const status = await git(["status", "--porcelain"]);
      if (status.stdout) {
        await git(["commit", "-m", message]);
      }
    } catch {
      // Best effort — don't let backup failure block shutdown
    }
  });
}

/** Synchronous commit for crash handlers (SIGINT/SIGTERM) */
function commitOnCrash(message = "crash: auto-backup"): void {
  if (!_repoReady) return;

  try {
    gitSync(["add", "-A"]);
    const status = gitSync(["status", "--porcelain"]);
    if (status.stdout) {
      gitSync(["commit", "-m", message]);
    }
  } catch {
    // Best effort
  }
}

export function registerCrashHandlers(): void {
  if (process.listenerCount("SIGTERM") > 0) return;

  const handler = (signal: string) => {
    commitOnCrash(`${signal}: auto-backup`);
    process.exit(1);
  };

  process.on("SIGTERM", () => handler("SIGTERM"));

  // SIGINT from outside (kill -INT) — Ink handles Ctrl+C via useInput in raw mode
  process.on("SIGINT", () => handler("SIGINT"));

  process.on("uncaughtException", (err) => {
    console.error("Uncaught exception:", err);
    commitOnCrash("uncaught exception: auto-backup");
    process.exit(1);
  });

  process.on("unhandledRejection", (reason) => {
    console.error("Unhandled rejection:", reason);
    commitOnCrash("unhandled rejection: auto-backup");
    process.exit(1);
  });
}
