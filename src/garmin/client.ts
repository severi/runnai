/**
 * Garmin Connect data source. Mirrors the Strava client's sync / detail /
 * stream functions (same signatures, same Strava-shaped results) so callers
 * switch sources without branching.
 *
 * Garmin has no usable public API for individuals, so the network side runs in
 * scripts/garmin_fit.py (python-garminconnect, whose browser-impersonating auth
 * is the fragile part we want maintained upstream). This module spawns it, maps
 * its JSON, and parses the downloaded FIT files for streams, laps and best
 * efforts.
 */
import { execFile } from "child_process";
import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";
import FitParser from "fit-file-parser";
import { PROJECT_ROOT, getDataDir } from "../utils/paths.js";
import {
  upsertActivities,
  upsertGear,
  getLatestActivityDate,
  findActivityNearStart,
  getActivitySource,
  getDb,
} from "../utils/activities-db.js";
import { generateRecentSummary } from "../utils/recent-summary.js";
import type { ActivityStream, StravaActivity, StravaBestEffort, StravaLap, SyncResult } from "../types/index.js";
import {
  garminSummaryToActivity,
  garminGearId,
  fitRecordsToStream,
  fitLapsToStravaLaps,
  computeBestEfforts,
  type GarminSyncItem,
  type FitRecord,
  type FitLap,
} from "./mapping.js";

/** A Garmin activity and an existing row this close in start time are the same session. */
export const DEDUPE_WINDOW_SEC = 60;

const LOGIN_COMMAND = ".venv-garmin/bin/python scripts/garmin_fit.py login";

function pythonBin(): string {
  return process.env.GARMIN_PYTHON || path.join(PROJECT_ROOT, ".venv-garmin/bin/python");
}

function scriptPath(): string {
  return path.join(PROJECT_ROOT, "scripts/garmin_fit.py");
}

export function getFitPath(activityId: number): string {
  return path.join(getDataDir(), "fit", `${activityId}_ACTIVITY.fit`);
}

export class GarminBridgeError extends Error {
  constructor(message: string, readonly needsAuth: boolean) {
    super(message);
  }
}

/** Run one garmin_fit.py command and parse its stdout JSON. */
export function runBridge<T>(args: string[], timeoutMs = 300_000): Promise<T> {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(pythonBin())) {
      reject(new GarminBridgeError(
        "Garmin helper not installed. Run: python3 -m venv .venv-garmin && " +
          ".venv-garmin/bin/pip install -r scripts/requirements-garmin.txt",
        true,
      ));
      return;
    }
    execFile(
      pythonBin(),
      [scriptPath(), ...args],
      {
        cwd: PROJECT_ROOT,
        timeout: timeoutMs,
        maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, RUNNAI_DATA_DIR: getDataDir() },
      },
      (error, stdout, stderr) => {
        if (error) {
          const detail = (stderr || error.message).trim();
          // garmin_fit.py exits with these phrases when it has no usable tokens
          // and no terminal to prompt on — the athlete has to log in once.
          const needsAuth = /not signed in|tokens have expired|fresh interactive login/i.test(detail);
          reject(new GarminBridgeError(
            needsAuth ? `Garmin sign-in needed. Run in your terminal: ${LOGIN_COMMAND}` : `Garmin sync failed: ${detail.split("\n").slice(-3).join(" ")}`,
            needsAuth,
          ));
          return;
        }
        try {
          resolve(JSON.parse(stdout) as T);
        } catch {
          reject(new GarminBridgeError(`Garmin helper returned non-JSON output: ${stdout.slice(0, 200)}`, false));
        }
      },
    );
  });
}

// --- FIT parsing (cached: detail and stream fetches both read the same file) ---

interface ParsedFit {
  records: FitRecord[];
  laps: FitLap[];
}

const fitCache = new Map<number, ParsedFit>();

async function parseFitFile(filePath: string): Promise<ParsedFit> {
  const buf = await fsp.readFile(filePath);
  const data = await new Promise<any>((resolve, reject) => {
    new FitParser({ force: true, mode: "list" }).parse(buf, (err: unknown, d: unknown) => (err ? reject(err) : resolve(d)));
  });
  return { records: data.records ?? [], laps: data.laps ?? [] };
}

async function loadFit(activityId: number): Promise<ParsedFit | null> {
  const cached = fitCache.get(activityId);
  if (cached) return cached;
  // Strava-era rows have Strava ids; Garmin has no FIT under that id.
  if (getActivitySource(activityId) === "strava") return null;

  const file = getFitPath(activityId);
  if (!fs.existsSync(file)) {
    await runBridge<{ fit_path: string | null }>(["fit", String(activityId)]);
    if (!fs.existsSync(file)) return null;
  }
  const parsed = await parseFitFile(file);
  if (fitCache.size > 20) fitCache.clear();
  fitCache.set(activityId, parsed);
  return parsed;
}

// --- Strava-compatible surface ---

export async function fetchActivityStream(activityId: number): Promise<ActivityStream | null> {
  const fit = await loadFit(activityId);
  return fit ? fitRecordsToStream(fit.records) : null;
}

export async function fetchActivityDetail(
  activityId: number
): Promise<{ bestEfforts: StravaBestEffort[]; laps: StravaLap[]; description: string | null }> {
  const row = getDb()
    .prepare("SELECT type, start_date_local, description FROM activities WHERE id = ?")
    .get(activityId) as { type: string; start_date_local: string; description: string | null } | null;
  // Callers write `description` back to the row; Garmin's notes came in with the
  // summary, so hand back what is stored rather than wiping it.
  const description = row?.description ?? null;

  const fit = await loadFit(activityId);
  if (!fit) return { bestEfforts: [], laps: [], description };

  const laps = fitLapsToStravaLaps(fit.laps, fit.records);
  let bestEfforts: StravaBestEffort[] = [];
  if (row?.type === "Run") {
    const stream = fitRecordsToStream(fit.records);
    if (stream) bestEfforts = computeBestEfforts(activityId, row.start_date_local, stream);
  }
  return { bestEfforts, laps, description };
}

/** The date to ask Garmin for, given the same options as the Strava sync. */
export function resolveSince(days: number, afterDate: string | undefined, incremental: boolean | undefined, latest: string | null, now = new Date()): string {
  const DAY = 24 * 60 * 60 * 1000;
  let since: Date;
  if (afterDate) since = new Date(afterDate);
  else if (incremental) {
    // Garmin filters by calendar day, and `latest` is a local time stored with
    // a Z; step back a day so nothing near midnight or across time zones slips.
    since = latest ? new Date(Date.parse(latest) - DAY) : new Date(now.getTime() - 180 * DAY);
  } else since = new Date(now.getTime() - days * DAY);
  return since.toISOString().slice(0, 10);
}

/**
 * Drop activities that duplicate an existing row from another source. Garmin
 * ids already in the table are kept (re-upserting them is a refresh); a Garmin
 * activity starting within the window of a different row is the same session
 * already in the Strava history.
 */
export function dropCrossSourceDuplicates(activities: StravaActivity[]): StravaActivity[] {
  return activities.filter(a => findActivityNearStart(a.start_date, DEDUPE_WINDOW_SEC, a.id) === null);
}

export async function syncActivities(days: number = 30, afterDate?: string, incremental?: boolean): Promise<SyncResult> {
  try {
    const since = resolveSince(days, afterDate, incremental, getLatestActivityDate());
    const result = await runBridge<{ activities: GarminSyncItem[] }>(["sync", "--since", since]);

    const mapped = result.activities
      .map(item => garminSummaryToActivity(item.summary, item.gear_uuid))
      .filter(a => a.start_date);
    const activities = dropCrossSourceDuplicates(mapped);

    await fsp.mkdir(path.join(getDataDir(), "strava"), { recursive: true });
    upsertActivities(activities);

    // Shoes with Garmin's lifetime distance. Best-effort, like Strava's gear refresh.
    try {
      const gear = await runBridge<{ shoes: Array<{ uuid: string; name: string; distance_m: number; retired: boolean }> }>(["gear"]);
      if (gear.shoes.length) {
        upsertGear(gear.shoes.map(s => ({
          id: garminGearId(s.uuid),
          name: s.name,
          primary: false,
          distance: s.distance_m,
          retired: s.retired,
        })));
      }
    } catch { /* gear sync is best-effort */ }

    await generateRecentSummary();

    const runs = activities.filter(a => a.type === "Run");
    return {
      success: true,
      activities: runs,
      allActivities: activities,
      summary: `${activities.length} activities from Garmin Connect since ${since} (${runs.length} runs).`,
    };
  } catch (error) {
    if (error instanceof GarminBridgeError) {
      return { success: false, error: error.message, needsAuth: error.needsAuth };
    }
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}
