import { describe, test, expect } from "bun:test";
import { computeLapGap } from "../activity-analysis.js";
import { minettiGapFactor } from "../stream-analysis.js";

// ─── computeLapGap ───────────────────────────────────────────────────────────
// Per-lap grade-adjusted pace. Without it, the only way to tell "slowed because
// the hill" from "slowed because tired" was to subtract gain/loss pairs by hand
// across every lap — so in practice the raw pace column got narrated directly,
// and a run that closed uphill got written up as a late fade (activity
// 19569913259, 2026-08-02).

const lap = (start_index: number, end_index: number) => ({ start_index, end_index });

/** Grade stream: `n` samples at a constant grade, offset by `pad` leading zeros. */
function gradeStream(pad: number, n: number, gradePct: number): number[] {
  return [...Array(pad).fill(0), ...Array(n).fill(gradePct)];
}

describe("computeLapGap", () => {
  test("flat lap: GAP equals raw pace", () => {
    const grades = gradeStream(0, 300, 0);
    expect(computeLapGap(grades, lap(0, 299), 300)).toBeCloseTo(300, 0);
  });

  test("uphill lap: GAP is faster than raw pace", () => {
    // Climbing costs more per metre, so the same effort yields a slower raw
    // pace — grade-adjusting must credit it back.
    const grades = gradeStream(0, 300, 5);
    const gap = computeLapGap(grades, lap(0, 299), 330)!;
    expect(gap).toBeLessThan(330);
  });

  test("downhill lap: GAP is slower than raw pace", () => {
    const grades = gradeStream(0, 300, -5);
    const gap = computeLapGap(grades, lap(0, 299), 290)!;
    expect(gap).toBeGreaterThan(290);
  });

  test("constant effort over a downhill lap then an uphill lap → equal GAP", () => {
    // The Aug 2 shape in miniature: raw pace diverges across the two laps, but
    // the athlete never changed effort, so the GAP column must be flat. This is
    // the comparison that distinguishes terrain from fatigue.
    const EFFORT_PACE = 300; // sec/km on the flat
    const grades = [...Array(300).fill(-3), ...Array(300).fill(3)];
    // Raw pace an athlete holding that effort would actually record on each grade.
    const rawDown = EFFORT_PACE * minettiGapFactor(-3);
    const rawUp = EFFORT_PACE * minettiGapFactor(3);
    expect(rawUp - rawDown).toBeGreaterThan(30); // raw column really does diverge

    const gapDown = computeLapGap(grades, lap(0, 299), rawDown)!;
    const gapUp = computeLapGap(grades, lap(300, 599), rawUp)!;

    expect(gapDown).toBeCloseTo(EFFORT_PACE, 0);
    expect(gapUp).toBeCloseTo(EFFORT_PACE, 0);
  });

  test("averages the cost factor, not the grade (rolling lap is not free)", () => {
    // A lap that climbs 3% for half and descends 3% for half averages to 0%
    // grade, but Minetti is non-linear: the climb costs more than the descent
    // saves. Averaging grade first would report the lap as flat.
    const rolling = [...Array(150).fill(3), ...Array(150).fill(-3)];
    const flat = gradeStream(0, 300, 0);
    const gapRolling = computeLapGap(rolling, lap(0, 299), 300)!;
    const gapFlat = computeLapGap(flat, lap(0, 299), 300)!;
    expect(gapRolling).toBeLessThan(gapFlat);
  });

  test("slices the lap's own index range, not the whole stream", () => {
    // Lap 2 climbs; lap 1 is flat. Using the whole stream would smear them.
    const grades = [...Array(300).fill(0), ...Array(300).fill(6)];
    const flatLap = computeLapGap(grades, lap(0, 299), 300)!;
    const climbLap = computeLapGap(grades, lap(300, 599), 300)!;
    expect(flatLap).toBeCloseTo(300, 0);
    expect(climbLap).toBeLessThan(flatLap - 20);
  });

  test("null grade stream, empty stream, or zero pace → null", () => {
    expect(computeLapGap(null, lap(0, 299), 300)).toBeNull();
    expect(computeLapGap([], lap(0, 299), 300)).toBeNull();
    expect(computeLapGap(gradeStream(0, 300, 0), lap(0, 299), 0)).toBeNull();
  });

  test("lap indices beyond the stream are clamped, degenerate ranges → null", () => {
    const grades = gradeStream(0, 100, 0);
    // end_index past the stream end clamps to the last sample.
    expect(computeLapGap(grades, lap(0, 5000), 300)).toBeCloseTo(300, 0);
    // A lap whose whole range sits past the stream has nothing to average.
    expect(computeLapGap(grades, lap(500, 600), 300)).toBeNull();
  });

  test("non-finite grade samples are skipped, not propagated as NaN", () => {
    const grades = [...Array(150).fill(0), ...Array(150).fill(NaN)];
    const gap = computeLapGap(grades, lap(0, 299), 300);
    expect(gap).not.toBeNull();
    expect(Number.isFinite(gap!)).toBe(true);
    expect(gap).toBeCloseTo(300, 0);
  });
});

// ─── saveActivityAnalysis: recompute must not destroy written prose ──────────
// computeActivityAnalysis returns detailed_analysis/strava_*/prose_summary as
// null (it computes metrics, it doesn't know what the coach wrote), and the
// upsert is INSERT OR REPLACE. Recomputes fire automatically on a
// STREAM_ANALYSIS_VERSION / CURRENT_ANALYSIS_VERSION bump, so without a
// coalesce a routine version bump silently wipes every athlete-facing analysis
// in the database.

import { beforeEach, afterEach } from "bun:test";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { saveActivityAnalysis } from "../activity-analysis.js";
import { getDb, closeDb } from "../activities-db.js";
import type { ActivityAnalysisRecord } from "../../types/index.js";

let tmp: string;
let originalEnv: string | undefined;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "runnai-activity-analysis-"));
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

/** A freshly computed record: real metrics, prose fields null. */
function computedRecord(activity_id: number, overrides: Partial<ActivityAnalysisRecord> = {}): ActivityAnalysisRecord {
  return {
    activity_id,
    run_type: "easy",
    run_type_detail: null,
    classification_confidence: "high",
    hill_category: "rolling",
    distance_m: 14600,
    moving_time_s: 4560,
    pace_sec_per_km: 313,
    elevation_gain_m: 93,
    elevation_loss_m: 90,
    grade_adjusted_pace_sec_per_km: 300,
    avg_heartrate: 151,
    max_heartrate: 168,
    lap_summaries: [],
    similar_runs_7d: 0,
    similar_runs_30d: 0,
    avg_pace_similar_30d: null,
    pace_vs_similar_delta: null,
    prose_summary: null,
    prose_generated_at: null,
    detailed_analysis: null,
    strava_title: null,
    strava_description: null,
    analysis_generated_at: null,
    analyzed_at: new Date().toISOString(),
    analysis_version: 4,
    ...overrides,
  };
}

/** activity_analysis has an FK to activities — the parent row must exist. */
function seedActivity(activity_id: number): void {
  getDb().prepare(`INSERT INTO activities (id, type, trainer) VALUES (?, 'Run', 0)`).run(activity_id);
}

function readProse(activity_id: number) {
  return getDb().prepare(
    `SELECT detailed_analysis, strava_title, strava_description, prose_summary, hill_category, avg_heartrate
     FROM activity_analysis WHERE activity_id = ?`
  ).get(activity_id) as any;
}

describe("saveActivityAnalysis", () => {
  test("a version-bump recompute preserves written prose", () => {
    seedActivity(1);
    saveActivityAnalysis(computedRecord(1, {
      detailed_analysis: "## The read: a steady moderate run",
      strava_title: "Steady 14.6k",
      strava_description: "Rolling loop home.",
      prose_summary: "14.6km steady",
    }));

    // Recompute: same activity, fresh metrics, prose fields null.
    saveActivityAnalysis(computedRecord(1, { avg_heartrate: 152, hill_category: "hilly" }));

    const row = readProse(1);
    expect(row.detailed_analysis).toBe("## The read: a steady moderate run");
    expect(row.strava_title).toBe("Steady 14.6k");
    expect(row.strava_description).toBe("Rolling loop home.");
    expect(row.prose_summary).toBe("14.6km steady");
    // ...while the recomputed metrics DO land.
    expect(row.avg_heartrate).toBe(152);
    expect(row.hill_category).toBe("hilly");
  });

  test("prose is still overwritten when a new value is supplied", () => {
    seedActivity(2);
    saveActivityAnalysis(computedRecord(2, { detailed_analysis: "first draft" }));
    saveActivityAnalysis(computedRecord(2, { detailed_analysis: "corrected draft" }));
    expect(readProse(2).detailed_analysis).toBe("corrected draft");
  });

  test("first insert with no prior row leaves prose null", () => {
    seedActivity(3);
    saveActivityAnalysis(computedRecord(3));
    const row = readProse(3);
    expect(row.detailed_analysis).toBeNull();
    expect(row.strava_title).toBeNull();
  });
});
