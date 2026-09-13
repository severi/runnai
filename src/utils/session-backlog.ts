/**
 * Non-run sessions from the last few days whose coaching read was never
 * saved: the sync ingested them (or not, if the stream fetch failed) but the
 * prior session ended before save_run_analysis ran. Startup re-surfaces them
 * so the coach opens with them, exactly as it does for runs.
 */

import { getDb } from "./activities-db.js";
import { isHrSessionCandidate, isStrengthSession } from "./hr-session.js";
import { isCrossTrainingCandidate } from "./cross-training.js";

export interface SessionMissingAnalysis {
  id: number;
  name: string | null;
  type: string;
  sport_type: string;
  start_date_local: string;
  elapsed_time: number;
  distance: number;
  average_heartrate: number | null;
  max_heartrate: number | null;
  average_watts: number | null;
  trainer: boolean;
}

export interface SessionBacklog {
  hrSessions: SessionMissingAnalysis[];
  crossTraining: SessionMissingAnalysis[];
  strength: SessionMissingAnalysis[];
}

interface Row extends Omit<SessionMissingAnalysis, "trainer"> {
  trainer: number | null;
  hr_read: string | null;
  cross_read: string | null;
  strength_read: string | null;
}

export function getRecentSessionsMissingDetailedAnalysis(days: number = 7): SessionBacklog {
  const rows = getDb().prepare(`
    SELECT a.id, a.name, a.type, a.sport_type, a.start_date_local, a.elapsed_time, a.distance,
           a.average_heartrate, a.max_heartrate, a.average_watts, a.trainer,
           h.detailed_analysis AS hr_read, c.detailed_analysis AS cross_read, s.detailed_analysis AS strength_read
    FROM activities a
    LEFT JOIN activity_hr_session_analysis h ON h.activity_id = a.id
    LEFT JOIN activity_cross_training_analysis c ON c.activity_id = a.id
    LEFT JOIN activity_strength_analysis s ON s.activity_id = a.id
    WHERE a.type != 'Run' AND a.sport_type != 'Run'
      AND a.start_date_local >= date('now', '-' || ? || ' days')
    ORDER BY a.start_date_local DESC
  `).all(days) as Row[];

  const backlog: SessionBacklog = { hrSessions: [], crossTraining: [], strength: [] };
  for (const r of rows) {
    const item: SessionMissingAnalysis = { ...r, trainer: r.trainer === 1 };
    if (isHrSessionCandidate(r)) {
      if (r.hr_read == null) backlog.hrSessions.push(item);
    } else if (isStrengthSession(r)) {
      if (r.strength_read == null) backlog.strength.push(item);
    } else if (isCrossTrainingCandidate(r)) {
      if (r.cross_read == null) backlog.crossTraining.push(item);
    }
  }
  return backlog;
}
