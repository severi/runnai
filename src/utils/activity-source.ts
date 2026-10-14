/**
 * The active data source's sync / detail / stream functions. Callers import
 * from here instead of a specific client, so Strava and Garmin installs run the
 * same pipeline. Both clients return Strava-shaped data.
 */
import * as strava from "../strava/client.js";
import * as garmin from "../garmin/client.js";
import { isGarminMode } from "./data-source.js";
import type { ActivityStream, StravaBestEffort, StravaLap, SyncResult } from "../types/index.js";

export { convertStravaBestEfforts } from "../strava/client.js";

export function syncActivities(days?: number, afterDate?: string, incremental?: boolean): Promise<SyncResult> {
  return isGarminMode() ? garmin.syncActivities(days, afterDate, incremental) : strava.syncActivities(days, afterDate, incremental);
}

export function fetchActivityDetail(
  activityId: number
): Promise<{ bestEfforts: StravaBestEffort[]; laps: StravaLap[]; description: string | null }> {
  return isGarminMode() ? garmin.fetchActivityDetail(activityId) : strava.fetchActivityDetail(activityId);
}

export function fetchActivityStream(activityId: number): Promise<ActivityStream | null> {
  return isGarminMode() ? garmin.fetchActivityStream(activityId) : strava.fetchActivityStream(activityId);
}
