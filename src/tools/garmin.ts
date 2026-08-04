import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { spawn } from "child_process";
import * as path from "path";
import * as fs from "fs";
import { toolResult, toolError } from "../utils/format.js";
import { PROJECT_ROOT } from "../utils/paths.js";

const VENV_PYTHON = path.join(PROJECT_ROOT, ".venv-garmin/bin/python");
const SCRIPT = path.join(PROJECT_ROOT, "scripts/garmin_fit.py");

/**
 * Run the Garmin helper and return its stdout.
 *
 * stdin is /dev/null on purpose: the script prompts for credentials only when
 * attached to a TTY, and there isn't one here. Without that it would block
 * forever on an invisible prompt instead of returning a usable error.
 */
function runGarmin(args: string[], timeoutMs = 120_000): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    if (!fs.existsSync(VENV_PYTHON)) {
      resolve({
        ok: false,
        out: "The Garmin helper isn't installed yet. Ask the athlete to run:\n"
          + "  python3 -m venv .venv-garmin\n"
          + "  .venv-garmin/bin/pip install -r scripts/requirements-garmin.txt",
      });
      return;
    }
    const child = spawn(VENV_PYTHON, [SCRIPT, ...args], {
      cwd: PROJECT_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => { out += d.toString(); });
    child.stderr.on("data", (d) => { err += d.toString(); });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, out: (out + err).trim() });
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ ok: false, out: String(e) });
    });
  });
}

function parseJson(out: string): Record<string, unknown> | null {
  const line = out.split("\n").map(l => l.trim()).filter(Boolean).pop();
  if (!line) return null;
  try {
    return JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export const garminAuthTool = tool(
  "garmin_auth",
  "Sign in to Garmin Connect so FIT files can be fetched. Call with no arguments to check status and start a sign-in; if it returns needs_mfa, ask the athlete for the 6-digit code and call again with mfa_code. Credentials come from GARMIN_EMAIL/GARMIN_PASSWORD in .env — never ask the athlete to type their password into the chat.",
  {
    mfa_code: z.string().optional().describe("The 6-digit MFA code, when completing a sign-in that returned needs_mfa."),
  },
  async ({ mfa_code }) => {
    try {
      if (mfa_code) {
        const { out } = await runGarmin(["auth", "--mfa-code", mfa_code]);
        const res = parseJson(out);
        if (res?.status === "ok") {
          return toolResult("Garmin connected. FIT fetches now run unattended — continue with what you were doing.");
        }
        return toolResult(
          `Garmin sign-in failed: ${res?.detail ?? out}\n`
          + "The code may have expired (they are short-lived). Call garmin_auth with no arguments to start over.",
          true,
        );
      }

      const status = parseJson((await runGarmin(["auth-status"])).out);
      if (status?.authenticated === true) {
        return toolResult("Garmin is already connected. Fetch away — no sign-in needed.");
      }

      const { out } = await runGarmin(["auth"]);
      const res = parseJson(out);

      switch (res?.status) {
        case "ok":
          return toolResult("Garmin connected. FIT fetches now run unattended — continue with what you were doing.");
        case "needs_mfa":
          return toolResult(
            "Garmin sent an MFA code to the athlete. **Ask them for the 6-digit code now and wait for it** — "
            + "this is one of the few cases where stopping to ask is correct, because nothing can proceed without it. "
            + "Then call garmin_auth again with mfa_code set. The code expires in about 30 seconds, so ask immediately "
            + "and do not batch the question with anything else.",
          );
        case "needs_credentials":
          return toolResult(
            "Garmin credentials aren't configured. Ask the athlete to add these to `.env` and then say when it's done:\n\n"
            + "    GARMIN_EMAIL=<their Garmin account email>\n"
            + "    GARMIN_PASSWORD=<their Garmin password>\n\n"
            + "Do NOT ask them to paste the password into this chat — it would be stored in the session transcript. "
            + "`.env` is gitignored and the password never reaches you.",
            true,
          );
        default:
          return toolResult(`Garmin sign-in failed: ${res?.detail ?? out}`, true);
      }
    } catch (error) {
      return toolError(error);
    }
  },
);

export const garminFetchFitTool = tool(
  "garmin_fetch_fit",
  "Download the original Garmin FIT file for an activity into data/fit/. This is the only way to see exercises, sets, reps, weights and true rest intervals for a strength session — Strava's API exposes none of it. Prefer start_time (the Strava activity's start_date); the two platforms share no id but record the same instant. Call garmin_auth first if not signed in.",
  {
    start_time: z.string().optional().describe("ISO8601 start of the activity, e.g. 2026-08-03T18:07:54Z. Use the Strava activity's start_date."),
    garmin_activity_id: z.string().optional().describe("Garmin activity id, if already known."),
  },
  async ({ start_time, garmin_activity_id }) => {
    try {
      if (!start_time && !garmin_activity_id) {
        return toolResult("Provide either start_time (preferred) or garmin_activity_id.", true);
      }
      const args = start_time
        ? ["fetch", "--at", start_time]
        : ["fetch", String(garmin_activity_id)];
      const { ok, out } = await runGarmin(args);

      if (!ok) {
        if (/not signed in|tokens have expired|rejected/i.test(out)) {
          return toolResult(
            `Not signed in to Garmin.\n\n${out}\n\n`
            + "Call garmin_auth to sign in — it does not need a terminal.",
            true,
          );
        }
        return toolResult(`Garmin fetch failed:\n${out}`, true);
      }
      return toolResult(
        `${out}\n\nLoad the strength-fit-import skill before parsing this — it holds the traps `
        + "(set.duration is not time-under-tension; watch-timed rests are not athlete behaviour; "
        + "warm-ups are flagged only in the split stream).",
      );
    } catch (error) {
      return toolError(error);
    }
  },
);
