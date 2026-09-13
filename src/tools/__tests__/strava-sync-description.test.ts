import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { stravaSyncTool } from "../strava.js";
import { getDb, closeDb } from "../../utils/activities-db.js";

let tmp: string;
let originalEnv: Record<string, string | undefined>;
let originalFetch: typeof fetch;

async function call(tool: any, input: any) {
  const handler = (tool as any).handler ?? (tool as any).execute;
  return handler(input);
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "runnai-sync-desc-"));
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

const BASKETBALL = {
  ...LIFT, id: 90000000002, name: "Night Basketball", type: "Workout", sport_type: "Basketball",
  start_date: "2026-09-08T18:02:04Z", start_date_local: "2026-09-08T21:02:04Z",
  moving_time: 3705, elapsed_time: 3705, average_heartrate: 152.7, max_heartrate: 187,
};

/** Strava's summary list never carries `description`; only the detail endpoint does. */
function stubStrava(activities: (typeof LIFT)[], detailDescription: string) {
  const detailCalls: number[] = [];
  const streamCalls: number[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("/athlete/activities")) return new Response(JSON.stringify(activities), { status: 200 });
    if (url.endsWith("/api/v3/athlete")) return new Response(JSON.stringify({ shoes: [] }), { status: 200 });
    const stream = url.match(/\/api\/v3\/activities\/(\d+)\/streams/);
    if (stream) {
      streamCalls.push(Number(stream[1]));
      const time = Array.from({ length: 600 }, (_, i) => i);
      return new Response(JSON.stringify({
        time: { data: time }, heartrate: { data: time.map(() => 150) },
      }), { status: 200 });
    }
    const detail = url.match(/\/api\/v3\/activities\/(\d+)$/);
    if (detail) {
      const id = Number(detail[1]);
      detailCalls.push(id);
      const act = activities.find((a) => a.id === id);
      return new Response(JSON.stringify({ ...act, description: detailDescription, best_efforts: [], laps: [] }), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
  return { detailCalls, streamCalls };
}

describe("strava_sync descriptions", () => {
  test("stores the athlete's description for a new weight-training activity", async () => {
    const { detailCalls, streamCalls } = stubStrava([LIFT], "squat back at 90, ankle fine");

    await call(stravaSyncTool, { incremental: false, days: 3 });

    expect(detailCalls).toContain(LIFT.id);
    const row = getDb().prepare("SELECT description FROM activities WHERE id = ?").get(LIFT.id) as { description: string | null };
    expect(row.description).toBe("squat back at 90, ankle fine");
    // A lift has no bout structure to analyse, so no stream call is spent on it.
    expect(streamCalls).not.toContain(LIFT.id);
  });

  test("intermittent-sport sessions still get their description and stream fetch", async () => {
    const { detailCalls, streamCalls } = stubStrava([BASKETBALL], "pickup, four games");

    await call(stravaSyncTool, { incremental: false, days: 3 });

    expect(detailCalls).toContain(BASKETBALL.id);
    expect(streamCalls).toContain(BASKETBALL.id);
    const row = getDb().prepare("SELECT description FROM activities WHERE id = ?").get(BASKETBALL.id) as { description: string | null };
    expect(row.description).toBe("pickup, four games");
  });
});
