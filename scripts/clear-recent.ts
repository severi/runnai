import { Database } from "bun:sqlite";
import * as path from "path";

const days = parseInt(process.argv[2]);
if (!days || days < 1) {
  console.error("Usage: bun scripts/clear-recent.ts <days>");
  process.exit(1);
}

const dbPath = path.join(import.meta.dir, "../data/strava/activities.db");
const db = new Database(dbPath);

const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
const rows = db.prepare("SELECT id, name, start_date_local FROM activities WHERE start_date_local >= ? ORDER BY start_date_local DESC").all(cutoff) as { id: number; name: string; start_date_local: string }[];

if (rows.length === 0) {
  console.log(`No activities found in the last ${days} days.`);
  process.exit(0);
}

console.log(`Deleting ${rows.length} activities from the last ${days} days:`);
for (const r of rows) {
  console.log(`  - ${r.start_date_local.split("T")[0]} ${r.name} (${r.id})`);
}

const ids = rows.map(r => r.id);
const placeholders = ids.map(() => "?").join(",");

db.exec("BEGIN");
for (const table of ["activity_streams", "activity_laps", "strava_best_efforts", "best_efforts"]) {
  db.prepare(`DELETE FROM ${table} WHERE activity_id IN (${placeholders})`).run(...ids);
}
db.prepare(`DELETE FROM activities WHERE id IN (${placeholders})`).run(...ids);
db.exec("COMMIT");

console.log("Done.");
db.close();
