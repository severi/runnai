import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { getCrossTrainingAnalysisTool } from "../cross-training-analysis.js";
import { saveRunAnalysisTool } from "../save-run-analysis.js";
import { getDb, closeDb, saveActivityStreams } from "../../utils/activities-db.js";
import { getCrossTrainingAnalysis } from "../../utils/cross-training.js";

let tmp: string;
let originalEnv: string | undefined;

async function call(tool: any, input: any) {
  const handler = (tool as any).handler ?? (tool as any).execute;
  return handler(input);
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "runnai-cross-training-tool-"));
  await fs.mkdir(path.join(tmp, "strava"), { recursive: true });
  await fs.mkdir(path.join(tmp, "athlete"), { recursive: true });
  originalEnv = process.env.RUNNAI_DATA_DIR;
  process.env.RUNNAI_DATA_DIR = tmp;
  closeDb();
});
afterEach(async () => {
  closeDb();
  if (originalEnv === undefined) delete process.env.RUNNAI_DATA_DIR;
  else process.env.RUNNAI_DATA_DIR = originalEnv;
  await fs.rm(tmp, { recursive: true, force: true });
});

function seed(id: number, type: string, sportType: string, date: string, description: string | null = null) {
  getDb().prepare(
    `INSERT INTO activities (id, name, type, sport_type, start_date_local, distance, moving_time, elapsed_time, total_elevation_gain,
       average_heartrate, max_heartrate, trainer, description, average_watts, weighted_average_watts, max_watts, kilojoules, device_watts)
     VALUES (?, 'Lunch Ride', ?, ?, ?, 0, 5400, 5400, 0, 130, 160, 1, ?, 165, 167, 291, 891, 1)`
  ).run(id, type, sportType, date, description);
}

function rideStream(seconds = 3600, watts = 200) {
  const time = Array.from({ length: seconds }, (_, i) => i);
  return { time, watts: time.map(() => watts), heartrate: time.map(() => 140) };
}

describe("get_cross_training_analysis tool", () => {
  test("returns the analysis, the summary power, athlete notes and earlier sessions of the same sport", async () => {
    seed(1, "Ride", "VirtualRide", "2026-09-06T12:00:00Z");
    saveActivityStreams(1, rideStream(3600, 180));
    seed(2, "Ride", "VirtualRide", "2026-09-13T12:00:00Z", "legs heavy after the lift");
    saveActivityStreams(2, rideStream());

    const result = await call(getCrossTrainingAnalysisTool, { activity_id: 2 });
    expect(result.isError).toBeUndefined();
    const out = JSON.parse(result.content[0].text);
    expect(out.activity.sport_type).toBe("VirtualRide");
    expect(out.activity.strava_power.weighted_average_watts).toBe(167);
    expect(out.activity.strava_power.device_watts).toBe(true);
    expect(out.activity.athlete_notes).toBe("legs heavy after the lift");
    expect(out.analysis.power.normalized_watts).toBe(200);
    expect(out.analysis.hr.avg).toBe(140);
    expect(out.previous_sessions.map((p: any) => p.activity_id)).toEqual([1]);
    expect(getCrossTrainingAnalysis(2)).not.toBeNull();
  });

  test("refuses a run, an intermittent session and a lift, each pointing at its own path", async () => {
    seed(3, "Run", "Run", "2026-09-06T12:00:00Z");
    seed(4, "Workout", "Basketball", "2026-09-06T12:00:00Z");
    seed(5, "WeightTraining", "WeightTraining", "2026-09-06T12:00:00Z");
    expect((await call(getCrossTrainingAnalysisTool, { activity_id: 3 })).content[0].text).toContain("get_run_analysis");
    expect((await call(getCrossTrainingAnalysisTool, { activity_id: 4 })).content[0].text).toContain("get_session_analysis");
    expect((await call(getCrossTrainingAnalysisTool, { activity_id: 5 })).content[0].text).toContain("strength-fit-import");
  });

  test("with no stream and no heart rate it says so instead of failing", async () => {
    seed(6, "Walk", "Walk", "2026-09-06T12:00:00Z");
    globalThis.fetch = (async () => new Response("{}", { status: 404 })) as unknown as typeof fetch;
    await fs.writeFile(path.join(tmp, "strava", "tokens.json"), JSON.stringify({ access_token: "t", refresh_token: "r", expires_at: Math.floor(Date.now() / 1000) + 3600 }));
    const result = await call(getCrossTrainingAnalysisTool, { activity_id: 6 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/no .*stream/i);
  });
});

describe("save_run_analysis for cross-training", () => {
  test("routes detailed_analysis to the cross-training record and refuses Strava fields", async () => {
    seed(7, "Ride", "VirtualRide", "2026-09-13T12:00:00Z");
    saveActivityStreams(7, rideStream());
    await call(getCrossTrainingAnalysisTool, { activity_id: 7 });

    const refused = await call(saveRunAnalysisTool, { activity_id: 7, detailed_analysis: "x", strava_description: "y" });
    expect(refused.isError).toBe(true);

    const saved = await call(saveRunAnalysisTool, { activity_id: 7, detailed_analysis: "Z2 trainer hour, decoupling under 3%." });
    expect(saved.isError).toBeUndefined();
    expect(JSON.parse(saved.content[0].text).kind).toBe("cross_training");
    expect(getCrossTrainingAnalysis(7)!.detailed_analysis).toBe("Z2 trainer hour, decoupling under 3%.");
  });
});
