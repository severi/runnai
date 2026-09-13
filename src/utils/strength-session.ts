/**
 * Strength sessions have no deterministic analysis (Strava exposes no sets,
 * reps or weights; the FIT import and the athlete's own account are the only
 * sources), but the coach's read still needs a home that survives the session
 * ending. `activity_strength_analysis` holds that read so it is saved before
 * the mandatory "paste the numbers" ask is posted, on the same footing as the
 * run, heart-rate session and cross-training records.
 */

import { getDb } from "./activities-db.js";

export interface StrengthRecord {
  activity_id: number;
  detailed_analysis: string | null;
  analysis_generated_at: string | null;
}

/** Upsert the coaching read for a lift. False when the activity is unknown. */
export function saveStrengthAnalysis(activityId: number, detailedAnalysis: string): boolean {
  const db = getDb();
  const exists = db.prepare("SELECT 1 FROM activities WHERE id = ?").get(activityId);
  if (!exists) return false;
  db.prepare(`
    INSERT INTO activity_strength_analysis (activity_id, detailed_analysis, analysis_generated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(activity_id) DO UPDATE SET
      detailed_analysis = excluded.detailed_analysis,
      analysis_generated_at = excluded.analysis_generated_at
  `).run(activityId, detailedAnalysis, new Date().toISOString());
  return true;
}

export function getStrengthAnalysis(activityId: number): StrengthRecord | null {
  const row = getDb().prepare("SELECT * FROM activity_strength_analysis WHERE activity_id = ?")
    .get(activityId) as StrengthRecord | undefined;
  return row ?? null;
}
