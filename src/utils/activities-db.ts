import { Database } from "bun:sqlite";
import * as path from "path";
import { fileURLToPath } from "url";
import type { StravaActivity, BestEffortRecord, RacePrediction, StravaBestEffortRecord, ActivityLapRecord, RunType } from "../types/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "../..");
export const ACTIVITIES_DB_PATH = path.join(PROJECT_ROOT, "data/strava/activities.db");

export function initDatabase(): Database {
  const db = new Database(ACTIVITIES_DB_PATH);

  db.exec(`
    CREATE TABLE IF NOT EXISTS activities (
      id INTEGER PRIMARY KEY,
      name TEXT,
      type TEXT,
      sport_type TEXT,
      start_date TEXT,
      start_date_local TEXT,
      distance REAL,
      moving_time INTEGER,
      elapsed_time INTEGER,
      total_elevation_gain REAL,
      average_speed REAL,
      max_speed REAL,
      average_heartrate REAL,
      max_heartrate REAL,
      suffer_score INTEGER,
      average_cadence REAL,
      workout_type INTEGER,
      description TEXT,
      trainer INTEGER DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_start_date ON activities(start_date_local);
    CREATE INDEX IF NOT EXISTS idx_type ON activities(type);
    CREATE INDEX IF NOT EXISTS idx_distance ON activities(distance);

    CREATE TABLE IF NOT EXISTS best_efforts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      activity_id INTEGER REFERENCES activities(id),
      distance_name TEXT,
      distance_meters REAL,
      elapsed_time REAL,
      pace_per_km REAL,
      start_index INTEGER,
      end_index INTEGER,
      computed_at TEXT,
      UNIQUE(activity_id, distance_name)
    );

    CREATE TABLE IF NOT EXISTS race_predictions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      race_distance TEXT,
      predicted_time REAL,
      confidence TEXT,
      basis TEXT,
      predicted_at TEXT
    );

    CREATE TABLE IF NOT EXISTS strava_best_efforts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      strava_effort_id INTEGER UNIQUE,
      activity_id INTEGER REFERENCES activities(id),
      distance_name TEXT,
      distance_meters REAL,
      elapsed_time REAL,
      moving_time REAL,
      pace_per_km REAL,
      start_index INTEGER,
      end_index INTEGER,
      pr_rank INTEGER,
      fetched_at TEXT,
      UNIQUE(activity_id, distance_name)
    );
    CREATE INDEX IF NOT EXISTS idx_sbe_distance ON strava_best_efforts(distance_name);

    CREATE TABLE IF NOT EXISTS personal_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      distance_name TEXT UNIQUE,
      time_seconds INTEGER,
      race_name TEXT,
      race_date TEXT,
      notes TEXT,
      recorded_at TEXT
    );
  `);

  // Migration: add trainer column to existing DBs
  try {
    db.exec("ALTER TABLE activities ADD COLUMN trainer INTEGER DEFAULT 0");
  } catch {
    // Column already exists
  }

  // Migration: add detail_fetched column
  try {
    db.exec("ALTER TABLE activities ADD COLUMN detail_fetched INTEGER DEFAULT 0");
  } catch {
    // Column already exists
  }

  // Migration: add location columns
  try {
    db.exec("ALTER TABLE activities ADD COLUMN start_latitude REAL");
  } catch {
    // Column already exists
  }
  try {
    db.exec("ALTER TABLE activities ADD COLUMN start_longitude REAL");
  } catch {
    // Column already exists
  }

  // Migration: add run_type columns
  try {
    db.exec("ALTER TABLE activities ADD COLUMN run_type TEXT");
  } catch {
    // Column already exists
  }
  try {
    db.exec("ALTER TABLE activities ADD COLUMN run_type_detail TEXT");
  } catch {
    // Column already exists
  }

  // Create activity_laps table
  db.exec(`
    CREATE TABLE IF NOT EXISTS activity_laps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      activity_id INTEGER REFERENCES activities(id),
      lap_index INTEGER,
      distance REAL,
      elapsed_time INTEGER,
      moving_time INTEGER,
      average_speed REAL,
      max_speed REAL,
      average_heartrate REAL,
      max_heartrate REAL,
      start_index INTEGER,
      end_index INTEGER,
      UNIQUE(activity_id, lap_index)
    );
  `);

  return db;
}

export function upsertActivities(activities: StravaActivity[]): void {
  const db = initDatabase();

  const upsert = db.prepare(`
    INSERT OR REPLACE INTO activities (
      id, name, type, sport_type, start_date, start_date_local,
      distance, moving_time, elapsed_time, total_elevation_gain,
      average_speed, max_speed, average_heartrate, max_heartrate, suffer_score,
      average_cadence, workout_type, description, trainer,
      start_latitude, start_longitude
    ) VALUES (
      $id, $name, $type, $sport_type, $start_date, $start_date_local,
      $distance, $moving_time, $elapsed_time, $total_elevation_gain,
      $average_speed, $max_speed, $average_heartrate, $max_heartrate, $suffer_score,
      $average_cadence, $workout_type, $description, $trainer,
      $start_latitude, $start_longitude
    )
  `);

  const insertMany = db.transaction((activities: StravaActivity[]) => {
    for (const activity of activities) {
      upsert.run({
        $id: activity.id,
        $name: activity.name,
        $type: activity.type,
        $sport_type: activity.sport_type,
        $start_date: activity.start_date,
        $start_date_local: activity.start_date_local,
        $distance: activity.distance,
        $moving_time: activity.moving_time,
        $elapsed_time: activity.elapsed_time,
        $total_elevation_gain: activity.total_elevation_gain,
        $average_speed: activity.average_speed,
        $max_speed: activity.max_speed,
        $average_heartrate: activity.average_heartrate ?? null,
        $max_heartrate: activity.max_heartrate ?? null,
        $suffer_score: activity.suffer_score ?? null,
        $average_cadence: activity.average_cadence ?? null,
        $workout_type: activity.workout_type ?? null,
        $description: activity.description ?? null,
        $trainer: activity.trainer ? 1 : 0,
        $start_latitude: activity.start_latlng?.[0] ?? null,
        $start_longitude: activity.start_latlng?.[1] ?? null,
      });
    }
  });

  insertMany(activities);
  db.close();
}

export function queryActivities(sql: string): unknown[] {
  if (!sql.trim().toLowerCase().startsWith("select")) {
    throw new Error("Only SELECT queries are allowed");
  }

  const db = initDatabase();
  try {
    return db.prepare(sql).all();
  } finally {
    db.close();
  }
}

export function getActivityCount(): number {
  const db = initDatabase();
  try {
    const result = db.prepare("SELECT COUNT(*) as count FROM activities").get() as { count: number };
    return result.count;
  } finally {
    db.close();
  }
}

export function getLatestActivityDate(): string | null {
  const db = initDatabase();
  try {
    const result = db.prepare("SELECT MAX(start_date_local) as latest FROM activities").get() as { latest: string | null };
    return result.latest;
  } finally {
    db.close();
  }
}

export function getExistingActivityIds(): Set<number> {
  const db = initDatabase();
  try {
    const rows = db.prepare("SELECT id FROM activities").all() as { id: number }[];
    return new Set(rows.map((r) => r.id));
  } finally {
    db.close();
  }
}

export function upsertBestEffort(record: BestEffortRecord): void {
  const db = initDatabase();
  try {
    db.prepare(`
      INSERT OR REPLACE INTO best_efforts (
        activity_id, distance_name, distance_meters, elapsed_time,
        pace_per_km, start_index, end_index, computed_at
      ) VALUES (
        $activity_id, $distance_name, $distance_meters, $elapsed_time,
        $pace_per_km, $start_index, $end_index, $computed_at
      )
    `).run({
      $activity_id: record.activity_id,
      $distance_name: record.distance_name,
      $distance_meters: record.distance_meters,
      $elapsed_time: record.elapsed_time,
      $pace_per_km: record.pace_per_km,
      $start_index: record.start_index,
      $end_index: record.end_index,
      $computed_at: record.computed_at,
    });
  } finally {
    db.close();
  }
}

export function getBestEfforts(distanceName?: string): BestEffortRecord[] {
  const db = initDatabase();
  try {
    if (distanceName) {
      return db.prepare(
        "SELECT * FROM best_efforts WHERE distance_name = ? ORDER BY elapsed_time ASC"
      ).all(distanceName) as BestEffortRecord[];
    }
    return db.prepare(
      "SELECT * FROM best_efforts ORDER BY distance_name, elapsed_time ASC"
    ).all() as BestEffortRecord[];
  } finally {
    db.close();
  }
}

export function savePrediction(prediction: RacePrediction): void {
  const db = initDatabase();
  try {
    db.prepare(`
      INSERT INTO race_predictions (race_distance, predicted_time, confidence, basis, predicted_at)
      VALUES ($race_distance, $predicted_time, $confidence, $basis, $predicted_at)
    `).run({
      $race_distance: prediction.race_distance,
      $predicted_time: prediction.predicted_time,
      $confidence: prediction.confidence,
      $basis: prediction.basis,
      $predicted_at: prediction.predicted_at,
    });
  } finally {
    db.close();
  }
}

export function getPredictionHistory(raceDistance?: string): RacePrediction[] {
  const db = initDatabase();
  try {
    if (raceDistance) {
      return db.prepare(
        "SELECT * FROM race_predictions WHERE race_distance = ? ORDER BY predicted_at DESC"
      ).all(raceDistance) as RacePrediction[];
    }
    return db.prepare(
      "SELECT * FROM race_predictions ORDER BY race_distance, predicted_at DESC"
    ).all() as RacePrediction[];
  } finally {
    db.close();
  }
}

export function upsertStravaBestEfforts(records: StravaBestEffortRecord[]): void {
  const db = initDatabase();
  try {
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO strava_best_efforts (
        strava_effort_id, activity_id, distance_name, distance_meters,
        elapsed_time, moving_time, pace_per_km, start_index, end_index,
        pr_rank, fetched_at
      ) VALUES (
        $strava_effort_id, $activity_id, $distance_name, $distance_meters,
        $elapsed_time, $moving_time, $pace_per_km, $start_index, $end_index,
        $pr_rank, $fetched_at
      )
    `);

    const insertMany = db.transaction((recs: StravaBestEffortRecord[]) => {
      for (const r of recs) {
        stmt.run({
          $strava_effort_id: r.strava_effort_id,
          $activity_id: r.activity_id,
          $distance_name: r.distance_name,
          $distance_meters: r.distance_meters,
          $elapsed_time: r.elapsed_time,
          $moving_time: r.moving_time,
          $pace_per_km: r.pace_per_km,
          $start_index: r.start_index,
          $end_index: r.end_index,
          $pr_rank: r.pr_rank,
          $fetched_at: r.fetched_at,
        });
      }
    });

    insertMany(records);
  } finally {
    db.close();
  }
}

export function markActivityDetailFetched(activityId: number): void {
  const db = initDatabase();
  try {
    db.prepare("UPDATE activities SET detail_fetched = 1 WHERE id = ?").run(activityId);
  } finally {
    db.close();
  }
}

export function getActivitiesWithoutDetail(limit: number = 50): { id: number; name: string; distance: number }[] {
  const db = initDatabase();
  try {
    return db.prepare(
      `SELECT id, name, distance FROM activities
       WHERE type = 'Run' AND trainer = 0 AND detail_fetched = 0
       ORDER BY start_date_local DESC LIMIT ?`
    ).all(limit) as { id: number; name: string; distance: number }[];
  } finally {
    db.close();
  }
}

export function getStravaBestEfforts(distanceName?: string): (StravaBestEffortRecord & { activity_name: string; start_date_local: string; activity_distance: number; workout_type: number | null; run_type: string | null })[] {
  const db = initDatabase();
  try {
    const baseQuery = `
      SELECT sbe.*, a.name as activity_name, a.start_date_local,
             a.distance as activity_distance, a.workout_type, a.run_type
      FROM strava_best_efforts sbe
      JOIN activities a ON sbe.activity_id = a.id
    `;
    if (distanceName) {
      return db.prepare(
        `${baseQuery} WHERE sbe.distance_name = ? ORDER BY sbe.elapsed_time ASC`
      ).all(distanceName) as any[];
    }
    return db.prepare(
      `${baseQuery} ORDER BY sbe.distance_name, sbe.elapsed_time ASC`
    ).all() as any[];
  } finally {
    db.close();
  }
}

export function upsertActivityLaps(activityId: number, laps: ActivityLapRecord[]): void {
  const db = initDatabase();
  try {
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO activity_laps (
        activity_id, lap_index, distance, elapsed_time, moving_time,
        average_speed, max_speed, average_heartrate, max_heartrate,
        start_index, end_index
      ) VALUES (
        $activity_id, $lap_index, $distance, $elapsed_time, $moving_time,
        $average_speed, $max_speed, $average_heartrate, $max_heartrate,
        $start_index, $end_index
      )
    `);

    const insertMany = db.transaction((records: ActivityLapRecord[]) => {
      for (const r of records) {
        stmt.run({
          $activity_id: activityId,
          $lap_index: r.lap_index,
          $distance: r.distance,
          $elapsed_time: r.elapsed_time,
          $moving_time: r.moving_time,
          $average_speed: r.average_speed,
          $max_speed: r.max_speed,
          $average_heartrate: r.average_heartrate,
          $max_heartrate: r.max_heartrate,
          $start_index: r.start_index,
          $end_index: r.end_index,
        });
      }
    });

    insertMany(laps);
  } finally {
    db.close();
  }
}

export function getActivityLaps(activityId: number): ActivityLapRecord[] {
  const db = initDatabase();
  try {
    return db.prepare(
      "SELECT * FROM activity_laps WHERE activity_id = ? ORDER BY lap_index ASC"
    ).all(activityId) as ActivityLapRecord[];
  } finally {
    db.close();
  }
}

export function setRunType(activityId: number, runType: RunType, runTypeDetail: string | null): void {
  const db = initDatabase();
  try {
    db.prepare(
      "UPDATE activities SET run_type = ?, run_type_detail = ? WHERE id = ?"
    ).run(runType, runTypeDetail, activityId);
  } finally {
    db.close();
  }
}

export interface PersonalRecord {
  id?: number;
  distance_name: string;
  time_seconds: number;
  race_name: string;
  race_date: string;
  notes: string | null;
  recorded_at: string;
}

export function upsertPersonalRecord(record: Omit<PersonalRecord, "id" | "recorded_at">): void {
  const db = initDatabase();
  try {
    db.prepare(`
      INSERT OR REPLACE INTO personal_records (distance_name, time_seconds, race_name, race_date, notes, recorded_at)
      VALUES ($distance_name, $time_seconds, $race_name, $race_date, $notes, $recorded_at)
    `).run({
      $distance_name: record.distance_name,
      $time_seconds: record.time_seconds,
      $race_name: record.race_name,
      $race_date: record.race_date,
      $notes: record.notes ?? null,
      $recorded_at: new Date().toISOString().split("T")[0],
    });
  } finally {
    db.close();
  }
}

export function getPersonalRecords(distanceName?: string): PersonalRecord[] {
  const db = initDatabase();
  try {
    if (distanceName) {
      return db.prepare(
        "SELECT * FROM personal_records WHERE distance_name = ?"
      ).all(distanceName) as PersonalRecord[];
    }
    return db.prepare(
      "SELECT * FROM personal_records ORDER BY distance_name"
    ).all() as PersonalRecord[];
  } finally {
    db.close();
  }
}

export function deletePersonalRecord(distanceName: string): boolean {
  const db = initDatabase();
  try {
    const result = db.prepare("DELETE FROM personal_records WHERE distance_name = ?").run(distanceName);
    return result.changes > 0;
  } finally {
    db.close();
  }
}

export function getUnclassifiedActivities(limit: number = 50): { id: number; name: string; distance: number; moving_time: number; workout_type: number | null; average_speed: number; average_heartrate: number | null; start_date_local: string }[] {
  const db = initDatabase();
  try {
    return db.prepare(
      `SELECT id, name, distance, moving_time, workout_type, average_speed, average_heartrate, start_date_local
       FROM activities
       WHERE type = 'Run' AND trainer = 0 AND detail_fetched = 1 AND run_type IS NULL
       ORDER BY start_date_local DESC LIMIT ?`
    ).all(limit) as any[];
  } finally {
    db.close();
  }
}
