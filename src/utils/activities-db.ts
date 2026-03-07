import { Database } from "bun:sqlite";
import * as path from "path";
import { getDataDir } from "./paths.js";
import type { StravaActivity, BestEffortRecord, RacePrediction, StravaBestEffortRecord, ActivityLapRecord, RunType, ActivityStream, ActivityStreamRecord, StreamAnalysisResult } from "../types/index.js";

export function getActivitiesDbPath(): string {
  return path.join(getDataDir(), "strava/activities.db");
}

export function initDatabase(): Database {
  const db = new Database(getActivitiesDbPath());

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

  // Migration: add streams_fetched column
  try {
    db.exec("ALTER TABLE activities ADD COLUMN streams_fetched INTEGER DEFAULT 0");
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

  // Migration: add elevation columns to activity_laps
  try {
    db.exec("ALTER TABLE activity_laps ADD COLUMN elevation_gain REAL");
  } catch {
    // Column already exists
  }
  try {
    db.exec("ALTER TABLE activity_laps ADD COLUMN elevation_loss REAL");
  } catch {
    // Column already exists
  }

  // Create activity_streams table
  db.exec(`
    CREATE TABLE IF NOT EXISTS activity_streams (
      activity_id INTEGER PRIMARY KEY REFERENCES activities(id),
      time_data TEXT NOT NULL,
      distance_data TEXT NOT NULL,
      heartrate_data TEXT,
      altitude_data TEXT,
      grade_smooth_data TEXT,
      cadence_data TEXT,
      fetched_at TEXT
    );
  `);

  // Create activity_stream_analysis table
  db.exec(`
    CREATE TABLE IF NOT EXISTS activity_stream_analysis (
      activity_id INTEGER PRIMARY KEY REFERENCES activities(id),
      hr_zone1_s INTEGER,
      hr_zone2_s INTEGER,
      hr_zone3_s INTEGER,
      hr_zone4_s INTEGER,
      hr_zone5_s INTEGER,
      hr_total_s INTEGER,
      cardiac_drift_pct REAL,
      pace_variability_cv REAL,
      split_type TEXT,
      trimp REAL,
      ngp_sec_per_km REAL,
      fatigue_index_pct REAL,
      cadence_drift_spm REAL,
      efficiency_factor REAL,
      phases TEXT,
      intervals TEXT,
      computed_at TEXT NOT NULL,
      stream_analysis_version INTEGER NOT NULL DEFAULT 1
    );
  `);

  // Create activity_analysis table
  db.exec(`
    CREATE TABLE IF NOT EXISTS activity_analysis (
      activity_id INTEGER PRIMARY KEY REFERENCES activities(id),
      run_type TEXT NOT NULL,
      run_type_detail TEXT,
      classification_confidence TEXT,
      hill_category TEXT,
      distance_m REAL,
      moving_time_s INTEGER,
      pace_sec_per_km REAL,
      elevation_gain_m REAL,
      elevation_loss_m REAL,
      grade_adjusted_pace_sec_per_km REAL,
      avg_heartrate REAL,
      max_heartrate REAL,
      lap_summaries TEXT,
      similar_runs_7d INTEGER,
      similar_runs_30d INTEGER,
      avg_pace_similar_30d REAL,
      pace_vs_similar_delta REAL,
      prose_summary TEXT,
      prose_generated_at TEXT,
      analyzed_at TEXT NOT NULL DEFAULT '',
      analysis_version INTEGER DEFAULT 1
    );
  `);

  // Migration: add detailed_analysis column to activity_analysis
  try {
    db.exec("ALTER TABLE activity_analysis ADD COLUMN detailed_analysis TEXT");
  } catch {
    // Column already exists
  }

  // Migration: add strava_title column to activity_analysis
  try {
    db.exec("ALTER TABLE activity_analysis ADD COLUMN strava_title TEXT");
  } catch {
    // Column already exists
  }

  // Migration: add strava_description column to activity_analysis
  try {
    db.exec("ALTER TABLE activity_analysis ADD COLUMN strava_description TEXT");
  } catch {
    // Column already exists
  }

  // Migration: add analysis_generated_at column to activity_analysis
  try {
    db.exec("ALTER TABLE activity_analysis ADD COLUMN analysis_generated_at TEXT");
  } catch {
    // Column already exists
  }

  // Create activity_weather table
  db.exec(`
    CREATE TABLE IF NOT EXISTS activity_weather (
      activity_id INTEGER PRIMARY KEY REFERENCES activities(id),
      temp_c REAL,
      feels_like_c REAL,
      humidity_pct REAL,
      wind_speed_kmh REAL,
      wind_gust_kmh REAL,
      precipitation_mm REAL,
      weather_code INTEGER,
      weather_description TEXT,
      fetched_at TEXT NOT NULL
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

export function computeLapElevation(altitude: number[], startIndex: number, endIndex: number): { gain: number; loss: number } {
  let gain = 0;
  let loss = 0;
  const start = Math.max(0, startIndex);
  const end = Math.min(altitude.length - 1, endIndex);
  for (let i = start + 1; i <= end; i++) {
    const delta = altitude[i] - altitude[i - 1];
    if (delta > 0) gain += delta;
    else loss += -delta;
  }
  return { gain: Math.round(gain * 10) / 10, loss: Math.round(loss * 10) / 10 };
}

export function upsertActivityLaps(activityId: number, laps: ActivityLapRecord[]): void {
  const db = initDatabase();
  try {
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO activity_laps (
        activity_id, lap_index, distance, elapsed_time, moving_time,
        average_speed, max_speed, average_heartrate, max_heartrate,
        start_index, end_index, elevation_gain, elevation_loss
      ) VALUES (
        $activity_id, $lap_index, $distance, $elapsed_time, $moving_time,
        $average_speed, $max_speed, $average_heartrate, $max_heartrate,
        $start_index, $end_index, $elevation_gain, $elevation_loss
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
          $elevation_gain: r.elevation_gain,
          $elevation_loss: r.elevation_loss,
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

export function saveActivityStreams(activityId: number, streams: ActivityStream): void {
  const db = initDatabase();
  try {
    db.prepare(`
      INSERT OR REPLACE INTO activity_streams (
        activity_id, time_data, distance_data, heartrate_data,
        altitude_data, grade_smooth_data, cadence_data, fetched_at
      ) VALUES (
        $activity_id, $time_data, $distance_data, $heartrate_data,
        $altitude_data, $grade_smooth_data, $cadence_data, $fetched_at
      )
    `).run({
      $activity_id: activityId,
      $time_data: JSON.stringify(streams.time),
      $distance_data: JSON.stringify(streams.distance),
      $heartrate_data: streams.heartrate ? JSON.stringify(streams.heartrate) : null,
      $altitude_data: streams.altitude ? JSON.stringify(streams.altitude) : null,
      $grade_smooth_data: streams.grade_smooth ? JSON.stringify(streams.grade_smooth) : null,
      $cadence_data: streams.cadence ? JSON.stringify(streams.cadence) : null,
      $fetched_at: new Date().toISOString(),
    });
    db.prepare("UPDATE activities SET streams_fetched = 1 WHERE id = ?").run(activityId);
  } finally {
    db.close();
  }
}

export function getActivityStreams(activityId: number): ActivityStream | null {
  const db = initDatabase();
  try {
    const row = db.prepare(
      "SELECT * FROM activity_streams WHERE activity_id = ?"
    ).get(activityId) as ActivityStreamRecord | undefined;
    if (!row) return null;
    return {
      time: JSON.parse(row.time_data!),
      distance: JSON.parse(row.distance_data!),
      heartrate: row.heartrate_data ? JSON.parse(row.heartrate_data) : undefined,
      altitude: row.altitude_data ? JSON.parse(row.altitude_data) : undefined,
      grade_smooth: row.grade_smooth_data ? JSON.parse(row.grade_smooth_data) : undefined,
      cadence: row.cadence_data ? JSON.parse(row.cadence_data) : undefined,
    };
  } finally {
    db.close();
  }
}

export function saveStreamAnalysis(activityId: number, result: StreamAnalysisResult, db: Database): void {
  db.prepare(`
    INSERT OR REPLACE INTO activity_stream_analysis (
      activity_id, hr_zone1_s, hr_zone2_s, hr_zone3_s, hr_zone4_s, hr_zone5_s, hr_total_s,
      cardiac_drift_pct, pace_variability_cv, split_type, trimp,
      ngp_sec_per_km, fatigue_index_pct, cadence_drift_spm, efficiency_factor,
      phases, intervals, computed_at, stream_analysis_version
    ) VALUES (
      $activity_id, $z1, $z2, $z3, $z4, $z5, $zt,
      $cardiac_drift, $pace_cv, $split_type, $trimp,
      $ngp, $fatigue, $cadence_drift, $ef,
      $phases, $intervals, $computed_at, $version
    )
  `).run({
    $activity_id: activityId,
    $z1: result.hr_zones?.zone1_s ?? null,
    $z2: result.hr_zones?.zone2_s ?? null,
    $z3: result.hr_zones?.zone3_s ?? null,
    $z4: result.hr_zones?.zone4_s ?? null,
    $z5: result.hr_zones?.zone5_s ?? null,
    $zt: result.hr_zones?.total_hr_s ?? null,
    $cardiac_drift: result.cardiac_drift_pct,
    $pace_cv: result.pace_variability_cv,
    $split_type: result.split_type,
    $trimp: result.trimp,
    $ngp: result.ngp_sec_per_km,
    $fatigue: result.fatigue_index_pct,
    $cadence_drift: result.cadence_drift_spm,
    $ef: result.efficiency_factor,
    $phases: JSON.stringify(result.phases),
    $intervals: JSON.stringify(result.intervals),
    $computed_at: result.computed_at,
    $version: result.stream_analysis_version,
  });
}

export function getStreamAnalysis(activityId: number, db: Database): StreamAnalysisResult | null {
  const row = db.prepare(
    "SELECT * FROM activity_stream_analysis WHERE activity_id = ?"
  ).get(activityId) as any;
  if (!row) return null;
  return {
    hr_zones: row.hr_total_s != null ? {
      zone1_s: row.hr_zone1_s ?? 0,
      zone2_s: row.hr_zone2_s ?? 0,
      zone3_s: row.hr_zone3_s ?? 0,
      zone4_s: row.hr_zone4_s ?? 0,
      zone5_s: row.hr_zone5_s ?? 0,
      total_hr_s: row.hr_total_s,
    } : null,
    cardiac_drift_pct: row.cardiac_drift_pct,
    pace_variability_cv: row.pace_variability_cv,
    split_type: row.split_type,
    trimp: row.trimp,
    ngp_sec_per_km: row.ngp_sec_per_km,
    fatigue_index_pct: row.fatigue_index_pct,
    cadence_drift_spm: row.cadence_drift_spm,
    efficiency_factor: row.efficiency_factor,
    phases: JSON.parse(row.phases || "[]"),
    intervals: JSON.parse(row.intervals || "[]"),
    computed_at: row.computed_at,
    stream_analysis_version: row.stream_analysis_version,
  };
}

export function getActivitiesWithoutStreamAnalysis(db: Database, limit: number = 50): number[] {
  return (db.prepare(`
    SELECT a.id FROM activities a
    INNER JOIN activity_streams s ON a.id = s.activity_id
    LEFT JOIN activity_stream_analysis sa ON a.id = sa.activity_id
    WHERE a.type = 'Run' AND a.trainer = 0 AND a.detail_fetched = 1
      AND sa.activity_id IS NULL
    ORDER BY a.start_date_local DESC LIMIT ?
  `).all(limit) as { id: number }[]).map(r => r.id);
}

export interface ActivityWeather {
  activity_id: number;
  temp_c: number | null;
  feels_like_c: number | null;
  humidity_pct: number | null;
  wind_speed_kmh: number | null;
  wind_gust_kmh: number | null;
  precipitation_mm: number | null;
  weather_code: number | null;
  weather_description: string | null;
  fetched_at: string;
}

export function saveActivityWeather(weather: ActivityWeather): void {
  const db = initDatabase();
  try {
    db.prepare(`
      INSERT OR REPLACE INTO activity_weather (
        activity_id, temp_c, feels_like_c, humidity_pct,
        wind_speed_kmh, wind_gust_kmh, precipitation_mm,
        weather_code, weather_description, fetched_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      weather.activity_id, weather.temp_c, weather.feels_like_c, weather.humidity_pct,
      weather.wind_speed_kmh, weather.wind_gust_kmh, weather.precipitation_mm,
      weather.weather_code, weather.weather_description, weather.fetched_at
    );
  } finally {
    db.close();
  }
}

export function getActivityWeather(activityId: number, db: Database): ActivityWeather | null {
  const row = db.prepare(
    "SELECT * FROM activity_weather WHERE activity_id = ?"
  ).get(activityId) as ActivityWeather | undefined;
  return row ?? null;
}

export function getActivitiesWithoutWeather(limit: number = 50): { id: number; start_date_local: string; start_latitude: number; start_longitude: number; moving_time: number }[] {
  const db = initDatabase();
  try {
    return db.prepare(`
      SELECT a.id, a.start_date_local, a.start_latitude, a.start_longitude, a.moving_time
      FROM activities a
      LEFT JOIN activity_weather w ON a.id = w.activity_id
      WHERE a.type = 'Run' AND a.trainer = 0
        AND a.start_latitude IS NOT NULL AND a.start_longitude IS NOT NULL
        AND w.activity_id IS NULL
      ORDER BY a.start_date_local DESC LIMIT ?
    `).all(limit) as any[];
  } finally {
    db.close();
  }
}
