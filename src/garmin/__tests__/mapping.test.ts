import { describe, test, expect } from "bun:test";
import {
  mapGarminType,
  garminSummaryToActivity,
  toStravaTimestamp,
  fitRecordsToStream,
  fitLapsToStravaLaps,
  computeBestEfforts,
  computeGrade,
  type GarminSummary,
  type FitRecord,
} from "../mapping.js";
import { isHrSessionCandidate, isStrengthSession } from "../../utils/hr-session.js";
import { isCrossTrainingCandidate } from "../../utils/cross-training.js";

const run: GarminSummary = {
  activityId: 90000000001,
  activityName: "Morning Run",
  activityType: { typeKey: "running" },
  eventType: { typeKey: "uncategorized" },
  startTimeGMT: "2026-04-12 07:00:00",
  startTimeLocal: "2026-04-12 09:00:00",
  distance: 10000,
  duration: 3005.4,
  movingDuration: 3000,
  elapsedDuration: 3005.4,
  elevationGain: 42,
  averageSpeed: 3.33,
  maxSpeed: 4.1,
  averageHR: 148,
  maxHR: 166,
  averageRunningCadenceInStepsPerMinute: 172,
  avgPower: 300,
  startLatitude: 51.92,
  startLongitude: 4.48,
};

describe("mapGarminType", () => {
  test("runs keep Strava's type split: trail is sport_type, treadmill is indoor", () => {
    expect(mapGarminType("running")).toMatchObject({ type: "Run", sport_type: "Run" });
    expect(mapGarminType("trail_running")).toMatchObject({ type: "Run", sport_type: "TrailRun" });
    expect(mapGarminType("treadmill_running")).toMatchObject({ type: "Run", indoor: true });
    expect(mapGarminType("ultra_run")).toMatchObject({ type: "Run", sport_type: "Run" });
  });

  test("court sports route to the HR-session layer, lifts to strength, rides to cross-training", () => {
    const asActivity = (key: string) => ({ ...mapGarminType(key), average_heartrate: 140 });
    expect(isHrSessionCandidate(asActivity("basketball"))).toBe(true);
    expect(isHrSessionCandidate(asActivity("paddelball"))).toBe(true);
    expect(isHrSessionCandidate(asActivity("tennis_v2"))).toBe(true);
    expect(isStrengthSession(asActivity("strength_training"))).toBe(true);
    expect(isCrossTrainingCandidate(asActivity("cycling"))).toBe(true);
    expect(isCrossTrainingCandidate(asActivity("walking"))).toBe(true);
    expect(isCrossTrainingCandidate(asActivity("running"))).toBe(false);
  });

  test("unknown types fall back to a generic Workout", () => {
    expect(mapGarminType("something_new")).toEqual({ type: "Workout", sport_type: "Workout" });
    expect(mapGarminType(null)).toEqual({ type: "Workout", sport_type: "Workout" });
  });
});

describe("garminSummaryToActivity", () => {
  test("maps a run into the Strava shape", () => {
    const a = garminSummaryToActivity(run, "abc123");
    expect(a).toMatchObject({
      id: 90000000001,
      name: "Morning Run",
      type: "Run",
      sport_type: "Run",
      start_date: "2026-04-12T07:00:00Z",
      start_date_local: "2026-04-12T09:00:00Z",
      distance: 10000,
      moving_time: 3000,
      elapsed_time: 3005,
      total_elevation_gain: 42,
      average_heartrate: 148,
      trainer: false,
      start_latlng: [51.92, 4.48],
      gear_id: "garmin:abc123",
      source: "garmin",
    });
    expect(a.workout_type).toBeUndefined();
  });

  test("foot-sport cadence is halved to Strava's per-leg convention", () => {
    expect(garminSummaryToActivity(run).average_cadence).toBe(86);
  });

  test("power is carried for rides only, as in Strava's summary", () => {
    expect(garminSummaryToActivity(run).average_watts).toBeUndefined();
    const ride = garminSummaryToActivity({
      ...run, activityType: { typeKey: "cycling" }, avgPower: 210, normPower: 225, maxPower: 600,
      averageBikingCadenceInRevPerMinute: 88,
    });
    expect(ride).toMatchObject({
      type: "Ride", average_watts: 210, weighted_average_watts: 225, max_watts: 600,
      kilojoules: 630, device_watts: true, average_cadence: 88,
    });
  });

  test("a race event sets Strava's race workout_type per family", () => {
    expect(garminSummaryToActivity({ ...run, eventType: { typeKey: "race" } }).workout_type).toBe(1);
    expect(garminSummaryToActivity({ ...run, activityType: { typeKey: "cycling" }, eventType: { typeKey: "race" } }).workout_type).toBe(11);
  });

  test("no GPS means trainer, like Strava's indoor sessions", () => {
    const lift = garminSummaryToActivity({
      ...run, activityType: { typeKey: "strength_training" }, distance: 0, startLatitude: null, startLongitude: null,
    });
    expect(lift).toMatchObject({ type: "WeightTraining", trainer: true, start_latlng: null });
  });

  test("sessions without distance use the whole session as moving time, as Strava does", () => {
    const court = garminSummaryToActivity({
      ...run, activityType: { typeKey: "basketball" }, distance: 0, movingDuration: 0, elapsedDuration: 3658,
    });
    expect(court.moving_time).toBe(3658);
    const lift = garminSummaryToActivity({
      ...run, activityType: { typeKey: "strength_training" }, distance: 0, movingDuration: 1460, elapsedDuration: 2636,
    });
    expect(lift.moving_time).toBe(2636);
  });

  test("timestamps convert from Garmin's two formats", () => {
    expect(toStravaTimestamp("2026-04-12 07:00:00")).toBe("2026-04-12T07:00:00Z");
    expect(toStravaTimestamp("2026-04-12T07:00:00.0")).toBe("2026-04-12T07:00:00Z");
    expect(toStravaTimestamp(null)).toBe("");
  });
});

/** A steady synthetic run: 1 Hz, `speed` m/s, gentle climb, HR from sample 2. */
function records(n: number, speed = 4, t0 = Date.parse("2026-04-12T07:00:00Z")): FitRecord[] {
  return Array.from({ length: n }, (_, i) => ({
    timestamp: new Date(t0 + i * 1000).toISOString(),
    distance: i * speed,
    enhanced_altitude: 10 + i * speed * 0.02,
    heart_rate: i < 2 ? undefined : 140 + (i % 5),
    cadence: 85,
    position_lat: 51.9 + i * 1e-5,
    position_long: 4.4,
  }));
}

describe("fitRecordsToStream", () => {
  test("builds aligned columns with time relative to the first sample", () => {
    const s = fitRecordsToStream(records(30))!;
    expect(s.time.slice(0, 3)).toEqual([0, 1, 2]);
    expect(s.distance!.length).toBe(30);
    expect(s.heartrate!.length).toBe(30);
    expect(s.latlng![0]).toEqual([51.9, 4.4]);
    expect(s.watts).toBeUndefined();
  });

  test("leading gaps take the first real value; omitted columns stay undefined", () => {
    const s = fitRecordsToStream(records(10))!;
    expect(s.heartrate![0]).toBe(s.heartrate![2]);
  });

  test("an HR-only session has no distance stream and no grade", () => {
    const hrOnly = records(10).map(r => ({ timestamp: r.timestamp, heart_rate: 120 }));
    const s = fitRecordsToStream(hrOnly)!;
    expect(s.distance).toBeUndefined();
    expect(s.grade_smooth).toBeUndefined();
    expect(s.heartrate!.length).toBe(10);
  });

  test("grade is derived from altitude over distance", () => {
    const grade = computeGrade([0, 10, 20, 30, 40, 50, 60], [0, 0.2, 0.4, 0.6, 0.8, 1, 1.2]);
    expect(grade.every(g => g === 2)).toBe(true);
  });

  test("no records → null", () => {
    expect(fitRecordsToStream([])).toBeNull();
  });
});

describe("fitLapsToStravaLaps", () => {
  test("resolves stream indices from lap start times", () => {
    const recs = records(20);
    const laps = fitLapsToStravaLaps(
      [
        { start_time: recs[0].timestamp, total_elapsed_time: 10, total_timer_time: 10, total_distance: 40, avg_heart_rate: 141 },
        { start_time: recs[10].timestamp, total_elapsed_time: 10, total_timer_time: 9, total_distance: 40, enhanced_avg_speed: 4.2 },
      ],
      recs,
    );
    expect(laps[0]).toMatchObject({ lap_index: 1, start_index: 0, end_index: 9, average_heartrate: 141, average_speed: 4 });
    expect(laps[1]).toMatchObject({ lap_index: 2, start_index: 10, end_index: 19, moving_time: 9, average_speed: 4.2 });
  });
});

describe("computeBestEfforts", () => {
  test("finds the fastest window per standard distance it covers", () => {
    // 3 km: first 2 km at 4 m/s, last 1 km at 5 m/s.
    const time: number[] = [];
    const distance: number[] = [];
    for (let t = 0, d = 0; d <= 3000; t++) {
      time.push(t);
      distance.push(d);
      d += d < 2000 ? 4 : 5;
    }
    const efforts = computeBestEfforts(90000000001, "2026-04-12T09:00:00Z", { time, distance });
    const byName = Object.fromEntries(efforts.map(e => [e.name, e]));
    expect(Object.keys(byName)).toEqual(["400m", "1/2 mile", "1K", "1 mile"]);
    expect(byName["1K"].elapsed_time).toBe(200);
    expect(byName["400m"].elapsed_time).toBe(80);
    expect(byName["1K"].id).toBe(90000000001 * 100 + 2);
  });

  test("no distance stream → no efforts", () => {
    expect(computeBestEfforts(1, "", { time: [0, 1, 2] })).toEqual([]);
  });
});
