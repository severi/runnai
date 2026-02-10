import * as fs from "fs/promises";
import * as path from "path";
import { fileURLToPath } from "url";
import { initDatabase } from "./activities-db.js";
import type { HrZones } from "../types/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "../..");
const HR_ZONES_FILE = path.join(PROJECT_ROOT, "data/athlete/hr-zones.json");

export async function loadHrZones(): Promise<HrZones> {
  try {
    const data = await fs.readFile(HR_ZONES_FILE, "utf-8");
    const zones = JSON.parse(data) as HrZones;
    // Backwards compat: treat missing confirmed as true for existing files
    if (zones.confirmed === undefined) zones.confirmed = true;
    return zones;
  } catch {
    // No file yet — estimate from data and persist as unconfirmed
    const estimated = estimateHrZones();
    await saveHrZones(estimated);
    return estimated;
  }
}

export async function saveHrZones(zones: HrZones): Promise<void> {
  await fs.mkdir(path.dirname(HR_ZONES_FILE), { recursive: true });
  await fs.writeFile(HR_ZONES_FILE, JSON.stringify(zones, null, 2));
}

function estimateHrZones(): HrZones {
  const db = initDatabase();
  try {
    const rows = db.prepare(
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
  } finally {
    db.close();
  }
}

export function computeEasyPaceRef(): number {
  const db = initDatabase();
  try {
    const rows = db.prepare(
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
  } finally {
    db.close();
  }
}
