// Persistence and ingest for heart-rate-only sessions (court and racket sports).

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { getDb, closeDb, saveActivityStreams } from "../activities-db.js";
import {
  isHrSessionCandidate,
  ingestHrSession,
  getHrSessionAnalysis,
  updateHrSessionDetailedAnalysis,
  getRecentHrSessions,
} from "../hr-session.js";
import type { HrZones } from "../../types/index.js";

const zones: HrZones = { source: "manual", lt1: 160, lt2: 178, max_hr: 197, confirmed: true };

let tmp: string;
let originalEnv: string | undefined;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "runnai-hr-session-"));
  await fs.mkdir(path.join(tmp, "strava"), { recursive: true });
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

function seedActivity(id: number, sportType: string, date: string, name = `Session ${id}`) {
  getDb().prepare(
    `INSERT INTO activities (id, name, type, sport_type, start_date_local, elapsed_time, trainer) VALUES (?, ?, 'Workout', ?, ?, 3600, 1)`
  ).run(id, name, sportType, date);
}

/** 10 min warm-up then `games` bouts at 185 with 2 min breaks at 130. */
function gameStream(games: number) {
  const hr: number[] = [];
  for (let i = 0; i < 600; i++) hr.push(110 + Math.round(40 * i / 600));
  for (let g = 0; g < games; g++) {
    for (let i = 0; i < 240; i++) hr.push(185);
    if (g < games - 1) for (let i = 0; i < 120; i++) hr.push(i < 60 ? 185 - Math.round(55 * i / 60) : 130);
  }
  return { time: hr.map((_, i) => i), heartrate: hr };
}

describe("isHrSessionCandidate", () => {
  test("court, racket and team sports with heart rate qualify", () => {
    for (const sport of ["Basketball", "Tennis", "Badminton", "Padel", "Squash", "Soccer", "Floorball", "IceHockey", "Volleyball", "Handball", "Pickleball"]) {
      expect(isHrSessionCandidate({ type: "Workout", sport_type: sport, average_heartrate: 140 })).toBe(true);
    }
  });

  test("a generic Workout with heart rate qualifies, since many gym classes arrive untagged", () => {
    expect(isHrSessionCandidate({ type: "Workout", sport_type: "Workout", average_heartrate: 140 })).toBe(true);
  });

  test("runs, rides, lifting, walks and sessions without heart rate do not", () => {
    expect(isHrSessionCandidate({ type: "Run", sport_type: "Run", average_heartrate: 140 })).toBe(false);
    expect(isHrSessionCandidate({ type: "Ride", sport_type: "Ride", average_heartrate: 140 })).toBe(false);
    expect(isHrSessionCandidate({ type: "WeightTraining", sport_type: "WeightTraining", average_heartrate: 110 })).toBe(false);
    expect(isHrSessionCandidate({ type: "Walk", sport_type: "Walk", average_heartrate: 90 })).toBe(false);
    expect(isHrSessionCandidate({ type: "Workout", sport_type: "Basketball" })).toBe(false);
  });
});

describe("ingestHrSession", () => {
  test("computes from the cached stream and persists the result under the activity's sport", () => {
    seedActivity(1, "Basketball", "2026-08-25T21:04:33Z");
    saveActivityStreams(1, gameStream(4));

    const result = ingestHrSession(1, zones);

    expect(result).not.toBeNull();
    expect(result!.bouts.filter(b => !b.is_warmup)).toHaveLength(4);
    const stored = getHrSessionAnalysis(1);
    expect(stored).not.toBeNull();
    expect(stored!.sport_type).toBe("Basketball");
    expect(stored!.result.bouts).toHaveLength(result!.bouts.length);
    expect(stored!.detailed_analysis).toBeNull();
  });

  test("returns null and stores nothing when the stream has no heart rate", () => {
    seedActivity(2, "Tennis", "2026-08-20T18:00:00Z");
    saveActivityStreams(2, { time: [0, 1, 2] });

    expect(ingestHrSession(2, zones)).toBeNull();
    expect(getHrSessionAnalysis(2)).toBeNull();
  });

  test("accepts a stream passed in directly, as sync does right after fetching", () => {
    seedActivity(3, "Padel", "2026-08-21T18:00:00Z");

    const result = ingestHrSession(3, zones, gameStream(3));

    expect(result).not.toBeNull();
    expect(getHrSessionAnalysis(3)!.sport_type).toBe("Padel");
  });

  test("recomputing keeps the coaching analysis already written", () => {
    seedActivity(4, "Basketball", "2026-08-25T21:04:33Z");
    saveActivityStreams(4, gameStream(4));
    ingestHrSession(4, zones);
    updateHrSessionDetailedAnalysis(4, "Peaks held, floors held.");

    ingestHrSession(4, zones);

    expect(getHrSessionAnalysis(4)!.detailed_analysis).toBe("Peaks held, floors held.");
  });
});

describe("getRecentHrSessions", () => {
  test("lists earlier sessions of the same sport, newest first, excluding the current one", () => {
    seedActivity(10, "Basketball", "2026-08-25T21:04:33Z", "Week 1");
    seedActivity(11, "Tennis", "2026-08-27T18:00:00Z", "Tennis");
    seedActivity(12, "Basketball", "2026-09-01T21:04:33Z", "Week 2");
    seedActivity(13, "Basketball", "2026-09-08T21:04:33Z", "Week 3");
    for (const id of [10, 11, 12, 13]) {
      saveActivityStreams(id, gameStream(4));
      ingestHrSession(id, zones);
    }

    const rows = getRecentHrSessions("Basketball", { before: "2026-09-08T21:04:33Z", exclude: 13, limit: 5 });

    expect(rows.map(r => r.name)).toEqual(["Week 2", "Week 1"]);
    expect(rows[0].max_hr).toBe(185);
    expect(rows[0].play_bouts).toBe(4);
    expect(rows[0].time_above_90pct_s).toBeGreaterThan(0);
    expect(rows[0].detailed_analysis).toBeNull();
  });
});
