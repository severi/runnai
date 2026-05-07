import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { saveRunAnalysisTool } from "../save-run-analysis.js";
import { getDb, closeDb } from "../../utils/activities-db.js";

let tmp: string;
let originalEnv: string | undefined;

async function call(tool: any, input: any) {
  const handler = (tool as any).handler ?? (tool as any).execute;
  return handler(input);
}

function readRow(activity_id: number): {
  detailed_analysis: string | null;
  strava_title: string | null;
  strava_description: string | null;
} {
  return getDb()
    .prepare("SELECT detailed_analysis, strava_title, strava_description FROM activity_analysis WHERE activity_id = ?")
    .get(activity_id) as any;
}

function seedRow(activity_id: number, fields: { detailed_analysis?: string; strava_title?: string; strava_description?: string } = {}): void {
  const db = getDb();
  db.prepare(`INSERT INTO activities (id, type, trainer) VALUES (?, 'Run', 0)`).run(activity_id);
  db.prepare(`
    INSERT INTO activity_analysis (activity_id, run_type, detailed_analysis, strava_title, strava_description, analyzed_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    activity_id,
    "easy",
    fields.detailed_analysis ?? null,
    fields.strava_title ?? null,
    fields.strava_description ?? null,
    new Date().toISOString(),
  );
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "runnai-save-analysis-"));
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

describe("save_run_analysis tool", () => {
  test("updates detailed_analysis without touching strava_description", async () => {
    seedRow(1, { detailed_analysis: "old coaching", strava_description: "old strava" });

    const result = await call(saveRunAnalysisTool, {
      activity_id: 1,
      detailed_analysis: "new thorough coaching read",
    });

    expect(JSON.parse(result.content[0].text)).toMatchObject({
      saved: true,
      updated_detailed_analysis: true,
      updated_strava_title: false,
      updated_strava_description: false,
    });

    const row = readRow(1);
    expect(row.detailed_analysis).toBe("new thorough coaching read");
    expect(row.strava_description).toBe("old strava");
  });

  test("updates strava_description without touching detailed_analysis", async () => {
    seedRow(2, { detailed_analysis: "thorough coaching" });

    const result = await call(saveRunAnalysisTool, {
      activity_id: 2,
      strava_description: "tight public-feed version",
    });

    expect(JSON.parse(result.content[0].text)).toMatchObject({
      saved: true,
      updated_detailed_analysis: false,
      updated_strava_description: true,
    });

    const row = readRow(2);
    expect(row.detailed_analysis).toBe("thorough coaching");
    expect(row.strava_description).toBe("tight public-feed version");
  });

  test("updates strava_title independently", async () => {
    seedRow(3, { detailed_analysis: "coaching", strava_title: "old title", strava_description: "desc" });

    await call(saveRunAnalysisTool, {
      activity_id: 3,
      strava_title: "new title",
    });

    const row = readRow(3);
    expect(row.detailed_analysis).toBe("coaching");
    expect(row.strava_title).toBe("new title");
    expect(row.strava_description).toBe("desc");
  });

  test("updates multiple fields at once", async () => {
    seedRow(4);

    await call(saveRunAnalysisTool, {
      activity_id: 4,
      strava_title: "Commute home",
      strava_description: "9.3km at 5:57/km, the second leg of a daily double.",
    });

    const row = readRow(4);
    expect(row.detailed_analysis).toBeNull();
    expect(row.strava_title).toBe("Commute home");
    expect(row.strava_description).toBe("9.3km at 5:57/km, the second leg of a daily double.");
  });

  test("returns error when no fields provided", async () => {
    seedRow(5);

    const result = await call(saveRunAnalysisTool, { activity_id: 5 });

    expect(result.content[0].text).toContain("No fields provided");
  });

  test("returns error when activity has no analysis row", async () => {
    const result = await call(saveRunAnalysisTool, {
      activity_id: 999,
      detailed_analysis: "anything",
    });

    expect(result.content[0].text).toContain("No analysis record");
  });

  test("does NOT mirror detailed_analysis into strava_description (regression: split is real)", async () => {
    seedRow(6);

    await call(saveRunAnalysisTool, {
      activity_id: 6,
      detailed_analysis: "## What actually happened\n\nThorough coaching read with headers, plan-vs-actual context, EF analysis, what-to-do-next.",
    });

    const row = readRow(6);
    expect(row.detailed_analysis).toContain("## What actually happened");
    expect(row.strava_description).toBeNull();
  });
});
