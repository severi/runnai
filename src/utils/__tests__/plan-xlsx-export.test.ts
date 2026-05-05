import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import ExcelJS from "exceljs";
import { exportPlanToXlsx } from "../plan-xlsx.js";

const SAMPLE_PLAN = `---
title: Test
slug: test
created: 2026-03-05
---

# Test Plan

## Week 1: Build

**Dates:** Monday March 9 - Sunday March 15
**Target Volume:** ~50km
**Key Focus:** First build week.

| Day | Date | Session | Details |
|-----|------|---------|---------|
| Mon | Mar 9 | Easy | 9km easy. |
| Tue | Mar 10 | Tempo | 12km total tempo. |
| Sat | Mar 14 | Long Run | 26km easy. |
`;

let tmp: string;
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "runnai-xlsx-"));
});
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("exportPlanToXlsx", () => {
  test("writes a Schedule sheet with rows for each day", async () => {
    const outPath = path.join(tmp, "out.xlsx");
    await exportPlanToXlsx(SAMPLE_PLAN, "test", outPath);

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(outPath);
    const sched = wb.getWorksheet("Schedule");
    expect(sched).toBeTruthy();
    expect(sched!.actualRowCount).toBeGreaterThanOrEqual(4);

    const header = sched!.getRow(1).values as any[];
    expect(header).toContain("week");
    expect(header).toContain("date");
    expect(header).toContain("distance_km");
    expect(header).toContain("user_note");

    let foundLong = false;
    sched!.eachRow((row, rowNum) => {
      if (rowNum === 1) return;
      const sessionType = row.getCell(7).value;
      if (typeof sessionType === "string" && sessionType.toLowerCase().includes("long")) {
        foundLong = true;
      }
    });
    expect(foundLong).toBe(true);
  });

  test("Summary sheet has weekly_total_km formula", async () => {
    const outPath = path.join(tmp, "out.xlsx");
    await exportPlanToXlsx(SAMPLE_PLAN, "test", outPath);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(outPath);
    const summary = wb.getWorksheet("Summary");
    expect(summary).toBeTruthy();
    let foundFormula = false;
    summary!.eachRow((row, rowNum) => {
      if (rowNum === 1) return;
      row.eachCell((cell) => {
        if ((cell as any).formula && (cell as any).formula.toUpperCase().includes("SUM")) {
          foundFormula = true;
        }
      });
    });
    expect(foundFormula).toBe(true);
  });
});
