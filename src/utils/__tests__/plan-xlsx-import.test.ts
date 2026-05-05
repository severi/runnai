import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { exportPlanToXlsx, parseXlsxSchedule, diffScheduleAgainstPlan } from "../plan-xlsx.js";

const SAMPLE = `---
title: Test
slug: test
created: 2026-03-05
---

# Test

## Week 1: Build
**Key Focus:** First.

| Day | Date | Session | Details |
|-----|------|---------|---------|
| Mon | Mar 9 | Easy | 9km easy. |
| Tue | Mar 10 | Tempo | 12km tempo. |
`;

let tmp: string;
beforeEach(async () => { tmp = await fs.mkdtemp(path.join(os.tmpdir(), "runnai-imp-")); });
afterEach(async () => { await fs.rm(tmp, { recursive: true, force: true }); });

describe("xlsx import / parseXlsxSchedule", () => {
  test("round-trips: export → parse → produces same row count", async () => {
    const out = path.join(tmp, "out.xlsx");
    await exportPlanToXlsx(SAMPLE, "test", out);
    const rows = await parseXlsxSchedule(out);
    expect(rows.length).toBe(2);
    expect(rows[0].session_type.toLowerCase()).toBe("easy");
    expect(rows[1].session_type.toLowerCase()).toBe("tempo");
  });

  test("diffScheduleAgainstPlan flags distance changes and user notes", async () => {
    const out = path.join(tmp, "out.xlsx");
    await exportPlanToXlsx(SAMPLE, "test", out);
    const rows = await parseXlsxSchedule(out);
    rows[1].distance_km = 14; // user changed 12 → 14
    rows[0].user_note = "felt heavy"; // note added

    const diff = diffScheduleAgainstPlan(rows, SAMPLE);
    expect(diff.changes.some(c => c.kind === "distance_changed" && c.week === 1)).toBe(true);
    expect(diff.notes.some(n => n.note === "felt heavy")).toBe(true);
  });
});
