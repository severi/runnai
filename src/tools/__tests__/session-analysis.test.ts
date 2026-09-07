import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { getSessionAnalysisTool } from "../session-analysis.js";
import { getDb, closeDb, saveActivityStreams } from "../../utils/activities-db.js";

let tmp: string;
let originalEnv: string | undefined;

async function call(tool: any, input: any) {
  const handler = (tool as any).handler ?? (tool as any).execute;
  return handler(input);
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "runnai-session-analysis-"));
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

function seed(id: number, type: string, sportType: string, date: string, name: string, description: string | null = null) {
  getDb().prepare(
    `INSERT INTO activities (id, name, type, sport_type, start_date_local, elapsed_time, moving_time, average_heartrate, max_heartrate, trainer, description)
     VALUES (?, ?, ?, ?, ?, 3600, 3600, 150, 185, 1, ?)`
  ).run(id, name, type, sportType, date, description);
}

function gameStream(games: number) {
  const hr: number[] = [];
  for (let i = 0; i < 600; i++) hr.push(110 + Math.round(40 * i / 600));
  for (let g = 0; g < games; g++) {
    for (let i = 0; i < 240; i++) hr.push(185);
    if (g < games - 1) for (let i = 0; i < 120; i++) hr.push(i < 60 ? 185 - Math.round(55 * i / 60) : 130);
  }
  return { time: hr.map((_, i) => i), heartrate: hr };
}

describe("get_session_analysis tool", () => {
  test("returns the analysis with earlier sessions of the same sport for comparison", async () => {
    seed(1, "Workout", "Basketball", "2026-08-25T21:04:33Z", "Week 1");
    seed(2, "Workout", "Basketball", "2026-09-01T21:04:33Z", "Week 2");
    seed(3, "Workout", "Tennis", "2026-08-30T18:00:00Z", "Tennis");
    for (const id of [1, 2, 3]) saveActivityStreams(id, gameStream(4));

    await call(getSessionAnalysisTool, { activity_id: 1 });
    const result = await call(getSessionAnalysisTool, { activity_id: 2 });
    const out = JSON.parse(result.content[0].text);

    expect(out.activity).toMatchObject({ id: 2, sport_type: "Basketball", name: "Week 2" });
    expect(out.analysis.bouts.filter((b: any) => !b.is_warmup)).toHaveLength(4);
    expect(out.analysis.breaks).toHaveLength(3);
    expect(out.detailed_analysis).toBeNull();
    expect(out.previous_sessions.map((s: any) => s.name)).toEqual(["Week 1"]);
  });

  test("carries the athlete's Strava description as athlete_notes", async () => {
    seed(6, "Workout", "Basketball", "2026-09-03T21:04:33Z", "Pickup", "4 games, sat out the last one");
    saveActivityStreams(6, gameStream(4));

    const out = JSON.parse((await call(getSessionAnalysisTool, { activity_id: 6 })).content[0].text);
    expect(out.activity.athlete_notes).toBe("4 games, sat out the last one");
  });

  test("refuses a run and points at get_run_analysis", async () => {
    seed(4, "Run", "Run", "2026-08-25T07:00:00Z", "Morning Run");

    const result = await call(getSessionAnalysisTool, { activity_id: 4 });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("get_run_analysis");
  });

  test("serves the cached result until detection options ask for a recompute", async () => {
    seed(5, "Workout", "Padel", "2026-08-25T21:04:33Z", "Padel");
    saveActivityStreams(5, gameStream(4));

    const first = JSON.parse((await call(getSessionAnalysisTool, { activity_id: 5 })).content[0].text);
    const second = JSON.parse((await call(getSessionAnalysisTool, { activity_id: 5 })).content[0].text);
    expect(second.computed_at).toBe(first.computed_at);

    const tuned = JSON.parse((await call(getSessionAnalysisTool, {
      activity_id: 5,
      options: { bout_enter_bpm: 190, bout_exit_bpm: 186 },
    })).content[0].text);
    expect(tuned.analysis.thresholds.source).toBe("explicit");
    expect(tuned.analysis.bouts).toHaveLength(0);
  });
});
