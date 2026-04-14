import { getDb } from "./activities-db.js";
import { loadTrainingZones, saveHrZonesPart } from "./training-zones.js";
import type { HrZones } from "../types/index.js";

/**
 * Load HR zones. Reads the unified training-zones.json (which migrates from
 * legacy hr-zones.json on first call). Falls back to estimating from data
 * if no zones exist anywhere.
 */
export async function loadHrZones(): Promise<HrZones> {
  const zones = await loadTrainingZones();
  if (zones) {
    const { updated_at: _u, ...hr } = zones.hr;
    return hr;
  }
  // No file yet — estimate from data and persist as unconfirmed
  const estimated = estimateHrZones();
  await saveHrZonesPart(estimated, { notes: "Initial estimate from training data — unconfirmed" });
  return estimated;
}

/**
 * Save HR zones via the unified training-zones store.
 * Also appends an audit entry to zones-history.jsonl.
 */
export async function saveHrZones(
  zones: HrZones,
  options: { approvedBy?: string; notes?: string } = {}
): Promise<void> {
  await saveHrZonesPart(zones, options);
}

function estimateHrZones(): HrZones {
  const rows = getDb().prepare(
    `SELECT max_heartrate FROM activities
     WHERE type = 'Run' AND trainer = 0 AND max_heartrate IS NOT NULL
     ORDER BY max_heartrate ASC`
  ).all() as { max_heartrate: number }[];

  if (rows.length === 0) {
    return { source: "estimated", lt1: 148, lt2: 170, max_hr: 190, confirmed: false };
  }

  const p95Index = Math.floor(rows.length * 0.95);
  const maxHr = rows[p95Index].max_heartrate;
  const lt2 = Math.round(maxHr * 0.89);
  const lt1 = Math.round(maxHr * 0.82);

  return { source: "estimated", lt1, lt2, max_hr: maxHr, confirmed: false };
}

export function computeEasyPaceRef(): number {
  const rows = getDb().prepare(
    `SELECT moving_time, distance FROM activities
     WHERE type = 'Run' AND trainer = 0
       AND distance >= 5000 AND distance <= 15000
       AND average_speed > 0
     ORDER BY start_date_local DESC
     LIMIT 100`
  ).all() as { moving_time: number; distance: number }[];

  if (rows.length === 0) return 360; // 6:00/km fallback

  const paces = rows.map(r => (r.moving_time / r.distance) * 1000).sort((a, b) => a - b);

  // Median of the slower 60%
  const slowerPaces = paces.slice(Math.floor(paces.length * 0.4));
  const medianIndex = Math.floor(slowerPaces.length / 2);
  return slowerPaces[medianIndex];
}
