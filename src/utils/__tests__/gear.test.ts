import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import path from "path";

// Point the DB at a throwaway dir BEFORE importing the db module (getDb reads
// the path lazily, but a dynamic import keeps this airtight).
const tmp = mkdtempSync(path.join(tmpdir(), "rennen-gear-"));
mkdirSync(path.join(tmp, "strava"), { recursive: true });
process.env.RUNNAI_DATA_DIR = tmp;

const { upsertActivities, upsertGear, getGearWithUsage } = await import("../activities-db.js");

function run(id: number, gear_id: string | null, dateLocal: string, distance: number): any {
  return {
    id, name: `Run ${id}`, type: "Run", sport_type: "Run",
    start_date: dateLocal, start_date_local: dateLocal,
    distance, moving_time: 3600, elapsed_time: 3600,
    total_elevation_gain: 0, average_speed: distance / 3600, max_speed: 3,
    gear_id,
  };
}

describe("gear table", () => {
  test("upsertGear stores Strava shoes with authoritative distance, primary, retired", () => {
    upsertGear([
      { id: "g1", name: "Hoka Challenger 7 GTX", primary: false, distance: 567291, retired: false },
      { id: "g2", name: "Old Trainers", primary: false, distance: 845000, retired: true },
    ]);
    const gear = getGearWithUsage();
    const g1 = gear.find(g => g.id === "g1")!;
    expect(g1.name).toBe("Hoka Challenger 7 GTX");
    expect(g1.distance_m).toBe(567291);
    expect(g1.retired).toBe(false);
    expect(gear.find(g => g.id === "g2")!.retired).toBe(true);
  });

  test("attributes synced runs to gear via gear_id", () => {
    upsertActivities([
      run(101, "g1", "2026-05-30T06:45:00", 5070),
      run(102, "g1", "2026-05-31T22:00:00", 13660),
      run(103, "g2", "2026-05-20T10:00:00", 8000),
      run(104, null, "2026-05-19T10:00:00", 6000), // unattributed
    ]);
    const g1 = getGearWithUsage().find(g => g.id === "g1")!;
    expect(g1.runs_in_db).toBe(2);
    expect(g1.km_in_db).toBe(18.7);          // (5070 + 13660) / 1000
    expect(g1.last_used).toBe("2026-05-31T22:00:00");
  });

  test("upsertGear updates distance on re-sync (mileage stays live)", () => {
    upsertGear([{ id: "g1", name: "Hoka Challenger 7 GTX", primary: true, distance: 580000, retired: false }]);
    const g1 = getGearWithUsage().find(g => g.id === "g1")!;
    expect(g1.distance_m).toBe(580000);      // updated, not duplicated
    expect(g1.is_primary).toBe(true);
    expect(getGearWithUsage().filter(g => g.id === "g1").length).toBe(1);
  });
});
