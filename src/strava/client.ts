import "dotenv/config";
import * as fs from "fs/promises";
import * as path from "path";
import { captureOAuthCallback } from "./oauth-server.js";
import { upsertActivities } from "../utils/activities-db.js";
import { generateRecentSummary } from "../utils/recent-summary.js";
import type {
  StravaTokens,
  StravaAthlete,
  StravaActivity,
  SyncResult,
  AuthResult,
  AthleteProfileResult,
  ActivityStream,
  StravaBestEffort,
  StravaBestEffortRecord,
  StravaLap,
} from "../types/index.js";

import { getDataDir } from "../utils/paths.js";

function getStravaDataDir(): string {
  return path.join(getDataDir(), "strava");
}

function getTokensFile(): string {
  return path.join(getDataDir(), "strava/tokens.json");
}

const TOKEN_EXPIRY_BUFFER_SECONDS = 300;

// Concurrent refresh lock
let refreshPromise: Promise<StravaTokens> | null = null;

async function loadTokens(): Promise<StravaTokens | null> {
  try {
    const data = await fs.readFile(getTokensFile(), "utf-8");
    return JSON.parse(data);
  } catch {
    return null;
  }
}

async function saveTokens(tokens: StravaTokens): Promise<void> {
  await fs.mkdir(getStravaDataDir(), { recursive: true });
  await fs.writeFile(getTokensFile(), JSON.stringify(tokens, null, 2));
}

export function getAuthUrl(): string {
  const clientId = process.env.STRAVA_CLIENT_ID;
  if (!clientId) {
    throw new Error("STRAVA_CLIENT_ID not set in .env");
  }
  const redirectUri = "http://localhost:8888/callback";
  const scope = "read,activity:read_all,profile:read_all,activity:write";
  return `https://www.strava.com/oauth/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${scope}`;
}

async function refreshAccessToken(): Promise<StravaTokens> {
  const savedTokens = await loadTokens();
  const clientId = process.env.STRAVA_CLIENT_ID;
  const clientSecret = process.env.STRAVA_CLIENT_SECRET;
  const refreshToken = savedTokens?.refresh_token || process.env.STRAVA_REFRESH_TOKEN;

  if (!clientId || !clientSecret) {
    throw new Error("Missing STRAVA_CLIENT_ID or STRAVA_CLIENT_SECRET in .env");
  }
  if (!refreshToken) {
    throw new Error("NO_REFRESH_TOKEN");
  }

  const response = await fetch("https://www.strava.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    let errorJson: { message?: string; errors?: Array<{ code: string }> } | null = null;
    try {
      errorJson = JSON.parse(errorText);
    } catch {
      // Not JSON
    }

    const errorMessage = errorJson?.message || errorText;
    if (
      errorMessage.includes("invalid") ||
      errorMessage.includes("expired") ||
      errorJson?.errors?.some((e) => e.code === "invalid")
    ) {
      throw new Error("TOKEN_EXPIRED");
    }
    throw new Error(`Token refresh failed (${response.status}): ${errorMessage}`);
  }

  const newTokens = (await response.json()) as StravaTokens;
  await saveTokens(newTokens);
  return newTokens;
}

function needsRefresh(tokens: StravaTokens): boolean {
  const now = Math.floor(Date.now() / 1000);
  return now >= tokens.expires_at - TOKEN_EXPIRY_BUFFER_SECONDS;
}

export async function getAccessToken(): Promise<string> {
  let tokens = await loadTokens();

  if (!tokens) {
    throw new Error("NO_TOKENS");
  }

  if (needsRefresh(tokens)) {
    if (!refreshPromise) {
      refreshPromise = refreshAccessToken().finally(() => {
        refreshPromise = null;
      });
    }
    tokens = await refreshPromise;
  }

  return tokens.access_token;
}

export async function fetchActivityStream(activityId: number): Promise<ActivityStream | null> {
  const accessToken = await getAccessToken();

  const response = await fetch(
    `https://www.strava.com/api/v3/activities/${activityId}/streams?keys=time,distance&key_by_type=true`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );

  if (!response.ok) {
    return null;
  }

  const data = await response.json();
  if (!data.time?.data || !data.distance?.data) {
    return null;
  }

  return {
    time: data.time.data,
    distance: data.distance.data,
  };
}

const STRAVA_DISTANCE_NAME_MAP: Record<string, string> = {
  "400m": "400M",
  "1/2 mile": "800M",
  "1K": "1K",
  "1 mile": "1MILE",
  "2 mile": "2MILE",
  "5K": "5K",
  "10K": "10K",
  "15K": "15K",
  "10 mile": "10MILE",
  "20K": "20K",
  "Half-Marathon": "HALF",
  "30K": "30K",
  "Marathon": "MARATHON",
};

export async function fetchActivityDetail(
  activityId: number
): Promise<{ bestEfforts: StravaBestEffort[]; laps: StravaLap[] }> {
  const accessToken = await getAccessToken();

  const response = await fetch(
    `https://www.strava.com/api/v3/activities/${activityId}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );

  if (response.status === 429) {
    throw new Error("RATE_LIMITED");
  }

  if (!response.ok) {
    throw new Error(`Strava detail API error (${response.status}): ${await response.text()}`);
  }

  const data = (await response.json()) as {
    best_efforts?: StravaBestEffort[];
    laps?: StravaLap[];
  };
  return { bestEfforts: data.best_efforts || [], laps: data.laps || [] };
}

export interface ActivityUpdate {
  name?: string;
  description?: string;
  private_note?: string;  // Strava calls this "commute" field is separate; private_note is undocumented but works
}

export async function updateActivity(
  activityId: number,
  update: ActivityUpdate
): Promise<{ success: boolean; error?: string; needsReauth?: boolean }> {
  const accessToken = await getAccessToken();

  const body: Record<string, string> = {};
  if (update.name !== undefined) body.name = update.name;
  if (update.description !== undefined) body.description = update.description;

  const response = await fetch(
    `https://www.strava.com/api/v3/activities/${activityId}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }
  );

  if (response.status === 403) {
    return {
      success: false,
      needsReauth: true,
      error: "Missing write permissions. You need to re-authorize Strava with write access. Run /setup to reconnect.",
    };
  }

  if (!response.ok) {
    const errorText = await response.text();
    return { success: false, error: `Strava API error (${response.status}): ${errorText}` };
  }

  return { success: true };
}

export function convertStravaBestEfforts(
  activityId: number,
  efforts: StravaBestEffort[]
): StravaBestEffortRecord[] {
  const now = new Date().toISOString().split("T")[0];
  const records: StravaBestEffortRecord[] = [];

  for (const effort of efforts) {
    const distanceName = STRAVA_DISTANCE_NAME_MAP[effort.name];
    if (!distanceName) continue;

    const pacePerKm = (effort.elapsed_time / effort.distance) * 1000;

    records.push({
      strava_effort_id: effort.id,
      activity_id: activityId,
      distance_name: distanceName,
      distance_meters: effort.distance,
      elapsed_time: effort.elapsed_time,
      moving_time: effort.moving_time,
      pace_per_km: pacePerKm,
      start_index: effort.start_index,
      end_index: effort.end_index,
      pr_rank: effort.pr_rank,
      fetched_at: now,
    });
  }

  return records;
}

export async function syncActivities(days: number = 30): Promise<SyncResult> {
  try {
    const clientId = process.env.STRAVA_CLIENT_ID;
    const clientSecret = process.env.STRAVA_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
      return {
        success: false,
        error: "Strava credentials not configured (missing CLIENT_ID or CLIENT_SECRET)",
        needsAuth: true,
      };
    }

    const savedTokens = await loadTokens();
    const hasRefreshToken = savedTokens?.refresh_token || process.env.STRAVA_REFRESH_TOKEN;

    if (!hasRefreshToken) {
      return {
        success: false,
        error: "Strava not authorized yet",
        needsAuth: true,
        authUrl: getAuthUrl(),
      };
    }

    let accessToken: string;
    try {
      accessToken = await getAccessToken();
    } catch (error) {
      if (error instanceof Error) {
        if (error.message === "NO_REFRESH_TOKEN") {
          return { success: false, needsAuth: true, authUrl: getAuthUrl(), error: "Refresh token not configured" };
        }
        if (error.message === "TOKEN_EXPIRED") {
          return { success: false, needsAuth: true, authUrl: getAuthUrl(), error: "Your Strava refresh token has expired. You need to re-authorize." };
        }
        return { success: false, needsAuth: true, authUrl: getAuthUrl(), error: `Strava API error: ${error.message}` };
      }
      throw error;
    }

    const after = Math.floor(Date.now() / 1000) - days * 24 * 60 * 60;
    const activities: StravaActivity[] = [];
    let page = 1;

    while (true) {
      const response = await fetch(
        `https://www.strava.com/api/v3/athlete/activities?after=${after}&per_page=200&page=${page}`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );

      if (!response.ok) {
        const error = await response.text();
        if (response.status === 401) {
          return { success: false, needsAuth: true, authUrl: getAuthUrl(), error: "Strava session expired. Please reconnect." };
        }
        throw new Error(`Strava API error: ${error}`);
      }

      const batch = (await response.json()) as StravaActivity[];
      activities.push(...batch);

      if (batch.length < 200) break;
      page++;
    }

    await fs.mkdir(getStravaDataDir(), { recursive: true });
    upsertActivities(activities);
    await generateRecentSummary();

    const runs = activities.filter((a) => a.type === "Run" || a.sport_type === "Run");
    const summary = generateSyncSummary(runs, days);

    return { success: true, activities: runs, summary };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function generateSyncSummary(runs: StravaActivity[], days: number): string {
  if (runs.length === 0) {
    return `No running activities found in the last ${days} days.`;
  }

  const totalDistance = runs.reduce((sum, a) => sum + a.distance, 0) / 1000;
  const totalTime = runs.reduce((sum, a) => sum + a.moving_time, 0);
  const avgPace = totalTime / 60 / totalDistance;
  const avgPaceMin = Math.floor(avgPace);
  const avgPaceSec = Math.round((avgPace - avgPaceMin) * 60);

  let summary = `Last ${days} Days: ${runs.length} runs, ${totalDistance.toFixed(1)}km, `;
  summary += `avg ${avgPaceMin}:${String(avgPaceSec).padStart(2, "0")}/km\n\n`;
  summary += `Recent Runs:\n`;

  runs.slice(0, 5).forEach((run) => {
    const distKm = (run.distance / 1000).toFixed(1);
    const paceVal = run.moving_time / 60 / (run.distance / 1000);
    const paceMin = Math.floor(paceVal);
    const paceSec = Math.round((paceVal - paceMin) * 60);
    const date = new Date(run.start_date_local).toLocaleDateString();
    summary += `  - ${run.name} - ${distKm}km @ ${paceMin}:${String(paceSec).padStart(2, "0")}/km (${date})\n`;
  });

  if (runs.length > 5) {
    summary += `  ... and ${runs.length - 5} more\n`;
  }

  return summary;
}

export async function getCachedActivities(): Promise<StravaActivity[] | null> {
  try {
    const { getActivityCount } = await import("../utils/activities-db.js");
    const count = getActivityCount();
    if (count === 0) return null;
    return [{ id: 0 } as StravaActivity];
  } catch {
    return null;
  }
}

export async function exchangeCodeForTokens(code: string): Promise<AuthResult> {
  const clientId = process.env.STRAVA_CLIENT_ID;
  const clientSecret = process.env.STRAVA_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    return { success: false, error: "Missing STRAVA_CLIENT_ID or STRAVA_CLIENT_SECRET in .env file" };
  }

  try {
    const response = await fetch("https://www.strava.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        grant_type: "authorization_code",
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      let errorMessage = errorText;
      try {
        const errorJson = JSON.parse(errorText);
        errorMessage = errorJson.message || errorJson.error || errorText;
      } catch {
        // Use raw text
      }
      return { success: false, error: `Strava returned error: ${errorMessage}` };
    }

    const tokens = (await response.json()) as StravaTokens;
    await saveTokens(tokens);
    return { success: true };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function hasClientCredentials(): boolean {
  return !!(process.env.STRAVA_CLIENT_ID && process.env.STRAVA_CLIENT_SECRET);
}

export async function startAutomaticAuth(): Promise<AuthResult> {
  const clientId = process.env.STRAVA_CLIENT_ID;
  const clientSecret = process.env.STRAVA_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    return { success: false, error: "Missing STRAVA_CLIENT_ID or STRAVA_CLIENT_SECRET in .env file" };
  }

  try {
    const authUrl = getAuthUrl();
    const result = await captureOAuthCallback(authUrl, 8888);

    if (result.error) {
      return {
        success: false,
        error: `Strava authorization denied: ${result.error}${result.errorDescription ? ` - ${result.errorDescription}` : ""}`,
      };
    }

    if (!result.code) {
      return { success: false, error: "No authorization code received from Strava" };
    }

    return await exchangeCodeForTokens(result.code);
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function getAthleteProfile(): Promise<AthleteProfileResult> {
  try {
    const clientId = process.env.STRAVA_CLIENT_ID;
    const clientSecret = process.env.STRAVA_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
      return { success: false, error: "Strava credentials not configured", needsAuth: true };
    }

    const savedTokens = await loadTokens();
    if (!savedTokens?.refresh_token) {
      return { success: false, error: "Strava not authorized yet", needsAuth: true, authUrl: getAuthUrl() };
    }

    let accessToken: string;
    try {
      accessToken = await getAccessToken();
    } catch (error) {
      if (error instanceof Error && (error.message === "NO_TOKENS" || error.message === "TOKEN_EXPIRED")) {
        return { success: false, needsAuth: true, authUrl: getAuthUrl(), error: "Please re-authorize Strava" };
      }
      throw error;
    }

    const response = await fetch("https://www.strava.com/api/v3/athlete", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!response.ok) {
      if (response.status === 401) {
        return { success: false, needsAuth: true, authUrl: getAuthUrl(), error: "Strava session expired" };
      }
      throw new Error(`Strava API error: ${await response.text()}`);
    }

    const athlete = (await response.json()) as StravaAthlete;
    return { success: true, athlete };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}
