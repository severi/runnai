// A lift synced at session start used to vanish: the startup context only
// listed new runs and heart-rate sessions, so the CLI told the coach "no new
// activities" while the sync line said one had arrived, and the startup loop
// never fetched the lift's description. These pin both.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { startupSync } from "../startup-sync.js";
import { getDb, closeDb } from "../activities-db.js";

let tmp: string;
let originalEnv: Record<string, string | undefined>;
let originalFetch: typeof fetch;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "runnai-startup-strength-"));
  await fs.mkdir(path.join(tmp, "strava"), { recursive: true });
  await fs.mkdir(path.join(tmp, "athlete"), { recursive: true });
  await fs.writeFile(path.join(tmp, "strava", "tokens.json"), JSON.stringify({
    access_token: "test-token", refresh_token: "r", expires_at: Math.floor(Date.now() / 1000) + 3600,
  }));
  originalEnv = {
    RUNNAI_DATA_DIR: process.env.RUNNAI_DATA_DIR,
    STRAVA_CLIENT_ID: process.env.STRAVA_CLIENT_ID,
    STRAVA_CLIENT_SECRET: process.env.STRAVA_CLIENT_SECRET,
  };
  process.env.RUNNAI_DATA_DIR = tmp;
  process.env.STRAVA_CLIENT_ID = "id";
  process.env.STRAVA_CLIENT_SECRET = "secret";
  originalFetch = globalThis.fetch;
  closeDb();
});
afterEach(async () => {
  globalThis.fetch = originalFetch;
  closeDb();
  for (const [k, v] of Object.entries(originalEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await fs.rm(tmp, { recursive: true, force: true });
});

const LIFT = {
  id: 90000000001, name: "Night Weight Training", type: "WeightTraining", sport_type: "WeightTraining",
  start_date: "2026-09-12T18:40:52Z", start_date_local: "2026-09-12T21:40:52Z",
  distance: 0, moving_time: 2844, elapsed_time: 2844, total_elevation_gain: 0,
  average_speed: 0, max_speed: 0, average_heartrate: 92.6, max_heartrate: 140, trainer: false,
};

function stubStrava(description: string) {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("/athlete/activities")) return new Response(JSON.stringify([LIFT]), { status: 200 });
    if (url.endsWith("/api/v3/athlete")) return new Response(JSON.stringify({ shoes: [] }), { status: 200 });
    if (/\/api\/v3\/activities\/\d+$/.test(url)) {
      return new Response(JSON.stringify({ ...LIFT, description, best_efforts: [], laps: [] }), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
}

describe("startupSync with a new strength session", () => {
  test("lists the lift for the startup prompt and stores its description", async () => {
    stubStrava("back at 90kg, ankle fine");

    const ctx = await startupSync();

    expect(ctx.sync.status).toBe("new_activities");
    expect(ctx.sync.newStrengthSessionIds).toEqual([LIFT.id]);
    expect(ctx.sync.message).toContain("Night Weight Training");
    expect(ctx.sync.message).toContain(String(LIFT.id));
    const row = getDb().prepare("SELECT description FROM activities WHERE id = ?").get(LIFT.id) as { description: string | null };
    expect(row.description).toBe("back at 90kg, ankle fine");
  });
});
