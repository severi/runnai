// Persistence, ingest and the sport predicate for continuous cross-training.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { getDb, closeDb, saveActivityStreams } from "../activities-db.js";
import {
  isCrossTrainingCandidate,
  ingestCrossTraining,
  getCrossTrainingAnalysis,
  updateCrossTrainingDetailedAnalysis,
  getRecentCrossTraining,
} from "../cross-training.js";
import type { HrZones } from "../../types/index.js";

const zones: HrZones = { source: "manual", lt1: 160, lt2: 178, max_hr: 197, confirmed: true };

let tmp: string;
let originalEnv: string | undefined;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "runnai-cross-training-"));
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

function seedRide(id: number, date: string, sportType = "VirtualRide", name = `Ride ${id}`) {
  getDb().prepare(
    `INSERT INTO activities (id, name, type, sport_type, start_date_local, distance, moving_time, elapsed_time, total_elevation_gain, trainer, average_watts, device_watts)
     VALUES (?, ?, 'Ride', ?, ?, 30000, 3600, 3600, 200, 1, 200, 1)`
  ).run(id, name, sportType, date);
}

function rideStream(seconds = 3600, watts = 200) {
  const time = Array.from({ length: seconds }, (_, i) => i);
  return { time, watts: time.map(() => watts), heartrate: time.map(() => 140) };
}

describe("isCrossTrainingCandidate", () => {
  const a = (type: string, sport: string, hr: number | null = 140) => ({ type, sport_type: sport, average_heartrate: hr });
  test("rides, virtual rides, walks, hikes, ski and swims qualify", () => {
    for (const [t, s] of [["Ride", "Ride"], ["Ride", "VirtualRide"], ["Ride", "GravelRide"], ["Walk", "Walk"], ["Hike", "Hike"], ["NordicSki", "NordicSki"], ["Swim", "Swim"], ["Rowing", "Rowing"]]) {
      expect(isCrossTrainingCandidate(a(t, s))).toBe(true);
    }
  });
  test("runs, intermittent sports and lifts do not", () => {
    expect(isCrossTrainingCandidate(a("Run", "Run"))).toBe(false);
    expect(isCrossTrainingCandidate(a("Workout", "Basketball"))).toBe(false);
    expect(isCrossTrainingCandidate(a("WeightTraining", "WeightTraining"))).toBe(false);
    expect(isCrossTrainingCandidate(a("Workout", "Workout", null))).toBe(false);
  });
});

describe("ingestCrossTraining", () => {
  test("stores a versioned result and the summary fields the comparison needs", () => {
    seedRide(1, "2026-09-13T12:00:00Z");
    const result = ingestCrossTraining(1, zones, rideStream());
    expect(result).not.toBeNull();
    const rec = getCrossTrainingAnalysis(1)!;
    expect(rec.sport_type).toBe("VirtualRide");
    expect(rec.result.power!.normalized_watts).toBe(200);
    expect(rec.detailed_analysis).toBeNull();
  });

  test("uses the cached stream when none is passed", () => {
    seedRide(2, "2026-09-13T12:00:00Z");
    saveActivityStreams(2, rideStream());
    expect(ingestCrossTraining(2, zones)).not.toBeNull();
  });

  test("returns null and stores nothing without a stream", () => {
    seedRide(3, "2026-09-13T12:00:00Z");
    expect(ingestCrossTraining(3, zones)).toBeNull();
    expect(getCrossTrainingAnalysis(3)).toBeNull();
  });

  test("detailed_analysis survives a recompute", () => {
    seedRide(4, "2026-09-13T12:00:00Z");
    ingestCrossTraining(4, zones, rideStream());
    expect(updateCrossTrainingDetailedAnalysis(4, "steady endurance ride")).toBe(true);
    ingestCrossTraining(4, zones, rideStream(3600, 210));
    const rec = getCrossTrainingAnalysis(4)!;
    expect(rec.result.power!.avg_watts).toBe(210);
    expect(rec.detailed_analysis).toBe("steady endurance ride");
  });
});

describe("getRecentCrossTraining", () => {
  test("returns earlier sessions of the same sport, newest first, excluding the current one", () => {
    seedRide(10, "2026-09-01T12:00:00Z");
    seedRide(11, "2026-09-05T12:00:00Z");
    seedRide(12, "2026-09-13T12:00:00Z");
    seedRide(13, "2026-09-07T12:00:00Z", "Ride");
    for (const id of [10, 11, 12, 13]) ingestCrossTraining(id, zones, rideStream(3600, 100 + id));
    const prev = getRecentCrossTraining("VirtualRide", { before: "2026-09-13T12:00:00Z", exclude: 12 });
    expect(prev.map(p => p.activity_id)).toEqual([11, 10]);
    expect(prev[0].normalized_watts).toBe(111);
    expect(prev[0].avg_hr).toBe(140);
    expect(prev[0].distance_m).toBe(30000);
  });
});

describe("backfillCrossTrainingFromCache", () => {
  test("analyses same-sport sessions with a cached stream and no record, without touching others", async () => {
    const { backfillCrossTrainingFromCache } = await import("../cross-training.js");
    seedRide(20, "2026-09-01T12:00:00Z");
    seedRide(21, "2026-09-05T12:00:00Z");
    seedRide(22, "2026-09-07T12:00:00Z", "Ride");
    saveActivityStreams(20, rideStream());
    saveActivityStreams(22, rideStream());
    expect(backfillCrossTrainingFromCache("VirtualRide", zones)).toBe(1);
    expect(getCrossTrainingAnalysis(20)).not.toBeNull();
    expect(getCrossTrainingAnalysis(21)).toBeNull();
    expect(getCrossTrainingAnalysis(22)).toBeNull();
    expect(backfillCrossTrainingFromCache("VirtualRide", zones)).toBe(0);
  });
});
