// Sessions the coach analysed but never saved a read for used to vanish: the
// startup backlog only re-surfaced runs. This pins the backlog for heart-rate
// sessions, cross-training and strength, and the strength record itself.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { getDb, closeDb, saveActivityStreams } from "../activities-db.js";
import { getRecentSessionsMissingDetailedAnalysis } from "../session-backlog.js";
import { saveStrengthAnalysis, getStrengthAnalysis } from "../strength-session.js";
import { ingestHrSession, updateHrSessionDetailedAnalysis } from "../hr-session.js";
import { ingestCrossTraining, updateCrossTrainingDetailedAnalysis } from "../cross-training.js";
import type { HrZones } from "../../types/index.js";

const zones: HrZones = { source: "manual", lt1: 160, lt2: 178, max_hr: 197, confirmed: true };

let tmp: string;
let originalEnv: string | undefined;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "runnai-session-backlog-"));
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

function daysAgo(n: number): string {
  const d = new Date(Date.now() - n * 86400000);
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function seed(id: number, type: string, sportType: string, date: string, hr: number | null = 120) {
  getDb().prepare(
    `INSERT INTO activities (id, name, type, sport_type, start_date_local, distance, elapsed_time, moving_time, average_heartrate, max_heartrate, trainer)
     VALUES (?, ?, ?, ?, ?, 0, 3600, 3600, ?, 150, 0)`
  ).run(id, `${sportType} ${id}`, type, sportType, date, hr);
}

function hrStream() {
  const time = Array.from({ length: 1200 }, (_, i) => i);
  return { time, heartrate: time.map(() => 150), watts: time.map(() => 200) };
}

describe("strength record", () => {
  test("saves and reads a coaching analysis for a lift", () => {
    seed(1, "WeightTraining", "WeightTraining", daysAgo(1));
    expect(saveStrengthAnalysis(1, "squat back at 90")).toBe(true);
    expect(getStrengthAnalysis(1)?.detailed_analysis).toBe("squat back at 90");
    expect(saveStrengthAnalysis(1, "revised")).toBe(true);
    expect(getStrengthAnalysis(1)?.detailed_analysis).toBe("revised");
  });

  test("refuses an unknown activity", () => {
    expect(saveStrengthAnalysis(999, "x")).toBe(false);
  });
});

describe("getRecentSessionsMissingDetailedAnalysis", () => {
  test("lists each non-run type that has no saved read, newest first, inside the window", () => {
    seed(10, "Workout", "Basketball", daysAgo(2));          // HR session, never ingested
    seed(11, "Workout", "Basketball", daysAgo(3));          // ingested, no read
    seed(12, "Workout", "Basketball", daysAgo(4));          // ingested + read
    seed(13, "Ride", "VirtualRide", daysAgo(1));            // cross-training, ingested, no read
    seed(14, "Ride", "VirtualRide", daysAgo(5));            // cross-training + read
    seed(15, "WeightTraining", "WeightTraining", daysAgo(1)); // lift, no record
    seed(16, "WeightTraining", "WeightTraining", daysAgo(2)); // lift + record
    seed(17, "Run", "Run", daysAgo(1));                     // runs are handled elsewhere
    seed(18, "Workout", "Basketball", daysAgo(12));         // outside the window
    for (const id of [11, 12]) { saveActivityStreams(id, hrStream()); ingestHrSession(id, zones); }
    updateHrSessionDetailedAnalysis(12, "read");
    for (const id of [13, 14]) { saveActivityStreams(id, hrStream()); ingestCrossTraining(id, zones); }
    updateCrossTrainingDetailedAnalysis(14, "read");
    saveStrengthAnalysis(16, "read");

    const b = getRecentSessionsMissingDetailedAnalysis(7);
    expect(b.hrSessions.map(s => s.id)).toEqual([10, 11]);
    expect(b.crossTraining.map(s => s.id)).toEqual([13]);
    expect(b.strength.map(s => s.id)).toEqual([15]);
    expect(b.hrSessions[0].sport_type).toBe("Basketball");
  });

  test("is empty when everything is saved", () => {
    seed(20, "WeightTraining", "WeightTraining", daysAgo(1));
    saveStrengthAnalysis(20, "read");
    const b = getRecentSessionsMissingDetailedAnalysis(7);
    expect(b.hrSessions).toEqual([]);
    expect(b.crossTraining).toEqual([]);
    expect(b.strength).toEqual([]);
  });
});
