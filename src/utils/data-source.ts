import * as fs from "fs";
import * as path from "path";
import { getDataDir } from "./paths.js";

/**
 * Where activities come from. One per install: Strava (the default, OAuth +
 * v3 API) or Garmin Connect (FIT files via scripts/garmin_fit.py). Strava's
 * API became a paid add-on, so a Garmin-only install skips it entirely.
 *
 * Resolution: RUNNAI_DATA_SOURCE env var, then `dataSource` in
 * data/config.json, then "strava". Read on every call — cheap, and lets tests
 * and evals flip it per case.
 */
export type DataSource = "strava" | "garmin";

export function getDataSource(): DataSource {
  const env = process.env.RUNNAI_DATA_SOURCE?.trim().toLowerCase();
  if (env === "garmin" || env === "strava") return env;
  try {
    const raw = fs.readFileSync(path.join(getDataDir(), "config.json"), "utf-8");
    const value = (JSON.parse(raw) as { dataSource?: unknown }).dataSource;
    if (value === "garmin" || value === "strava") return value;
  } catch {
    // Missing or malformed config falls back to the default.
  }
  return "strava";
}

export function isGarminMode(): boolean {
  return getDataSource() === "garmin";
}

/** Human-facing name of the active source, for tool output and prompts. */
export function dataSourceLabel(): string {
  return isGarminMode() ? "Garmin Connect" : "Strava";
}
