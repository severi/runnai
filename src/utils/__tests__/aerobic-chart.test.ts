import { describe, test, expect } from "bun:test";
import {
  selectAerobicCohort,
  rollingMedianSeries,
  computeTrendWindows,
  monthlyRows,
  buildSummary,
  efToPace,
  type AerobicRunRow,
} from "../aerobic-chart.js";

// The whole point of this module is that the number in the text and the line
// on the chart come from the same cohort and the same rolling series. These
// tests pin the cohort rules and the window math on synthetic data; the Python
// side only draws what it is given.

let nextId = 1;
function run(date: string, over: Partial<AerobicRunRow> = {}): AerobicRunRow {
  const pace = over.pace_sec_per_km ?? 360;
  return {
    id: nextId++,
    date,
    avg_hr: 151, // equals the synthetic band's reference HR, so normalised pace == raw pace in fixtures
    avg_speed: 1000 / pace,
    pace_sec_per_km: pace,
    distance_km: 10,
    run_type: "easy",
    elev_per_km: 5,
    trainer: 0,
    stream_ef: null,
    cardiac_drift_pct: 2,
    temp_c: 10,
    weather_code: 1,
    tags: [],
    ...over,
  };
}

function daily(start: string, days: number, over: (i: number) => Partial<AerobicRunRow> = () => ({})): AerobicRunRow[] {
  const out: AerobicRunRow[] = [];
  const t0 = Date.parse(start + "T00:00:00Z");
  for (let i = 0; i < days; i++) {
    const d = new Date(t0 + i * 86_400_000).toISOString().slice(0, 10);
    out.push(run(d, over(i)));
  }
  return out;
}

describe("selectAerobicCohort", () => {
  test("band derives from LT1 and excludes what is not comparable", () => {
    const rows = [
      run("2026-01-01"),                                       // kept
      run("2026-01-02", { run_type: "tempo" }),                // hard
      run("2026-01-03", { trainer: 1 }),                       // treadmill
      run("2026-01-04", { tags: ["stroller"] }),               // load tag
      run("2026-01-05", { distance_km: 4 }),                   // short
      run("2026-01-06", { distance_km: 50 }),                  // long
      run("2026-01-07", { elev_per_km: 30 }),                  // hilly
      run("2026-01-08", { avg_hr: 170 }),                      // above band
      run("2026-01-09", { avg_hr: 120 }),                      // below band
      run("2026-01-10", { elev_per_km: null }),                // unknown elevation: kept
    ];
    const c = selectAerobicCohort(rows, { lt1: 160 });
    expect(c.hrBand).toEqual([141, 160]);
    expect(c.refHr).toBe(151);
    expect(c.runs.map(r => r.date)).toEqual(["2026-01-01", "2026-01-10"]);
    expect(c.excluded).toEqual({
      hard_type: 1, treadmill: 1, load_tag: 1, too_short: 1, too_long: 1, hilly: 1, hr_out_of_band: 2,
    });
  });

  test("prefers the stream (NGP) efficiency factor and converts it to m/min per bpm", () => {
    const rows = [
      run("2026-01-01", { stream_ef: 0.02 }),              // 0.02 m/s per bpm → 1.2 m/min per bpm
      run("2026-01-02", { pace_sec_per_km: 300, avg_hr: 150 }), // raw: 3.333 m/s * 60 / 150 = 1.3333
    ];
    const c = selectAerobicCohort(rows, { lt1: 160 });
    expect(c.runs[0].ef_source).toBe("ngp");
    expect(c.runs[0].ef).toBeCloseTo(1.2, 5);
    expect(c.runs[1].ef_source).toBe("raw");
    expect(c.runs[1].ef).toBeCloseTo(1.3333, 3);
    // normalised pace at the reference HR, not at the run's own HR
    expect(c.runs[0].norm_pace_sec_per_km).toBeCloseTo(efToPace(1.2, 151), 5);
  });

  test("flags a run-walk as an outlier against its ±45-day neighbourhood", () => {
    const rows = daily("2026-03-01", 12);
    rows.push(run("2026-03-13", { pace_sec_per_km: 900 })); // 15:00/km walk-heavy
    const c = selectAerobicCohort(rows, { lt1: 160 });
    const walk = c.runs.find(r => r.date === "2026-03-13")!;
    expect(walk.outlier).toBe(true);
    expect(c.runs.filter(r => r.outlier)).toHaveLength(1);
  });

  test("does not flag outliers when the neighbourhood is too thin", () => {
    const rows = [run("2026-03-01"), run("2026-03-02"), run("2026-03-13", { pace_sec_per_km: 900 })];
    const c = selectAerobicCohort(rows, { lt1: 160 });
    expect(c.runs.every(r => !r.outlier)).toBe(true);
  });

  test("falls back to a fixed band without confirmed zones", () => {
    const c = selectAerobicCohort([run("2026-01-01")], { lt1: null });
    expect(c.hrBand).toEqual([135, 155]);
  });
});

describe("rollingMedianSeries", () => {
  test("needs five runs in the window before it emits a point, and ignores outliers", () => {
    const rows = daily("2026-01-01", 8);
    const c = selectAerobicCohort(rows, { lt1: 160 });
    c.runs[2].outlier = true;
    const series = rollingMedianSeries(c.runs, 90);
    // 7 clean runs; first point once 5 are in the window → clean index 4 = 2026-01-06
    expect(series[0].date).toBe("2026-01-06");
    expect(series[0].n).toBe(5);
    expect(series[series.length - 1].n).toBe(7);
  });

  test("the window is trailing: an improvement shows up only after it happens", () => {
    // 20 days at 6:00/km then 20 days at 5:00/km
    const rows = daily("2026-01-01", 40, i => ({ pace_sec_per_km: i < 20 ? 360 : 300 }));
    const c = selectAerobicCohort(rows, { lt1: 160 });
    const series = rollingMedianSeries(c.runs, 10);
    const before = series.find(p => p.date === "2026-01-20")!;
    const after = series.find(p => p.date === "2026-02-09")!;
    expect(before.ef).toBeCloseTo((1000 / 360) * 60 / 151, 4);
    expect(after.ef).toBeCloseTo((1000 / 300) * 60 / 151, 4);
  });
});

describe("computeTrendWindows", () => {
  test("start, now, peak and year-ago windows come from the same series", () => {
    // 15 months: slow start, peak in the middle, slight fade at the end
    const rows = daily("2025-07-01", 450, i => {
      const pace = i < 90 ? 420 : i < 300 ? 330 : 345;
      return { pace_sec_per_km: pace };
    }).filter((_, i) => i % 3 === 0); // every third day
    const c = selectAerobicCohort(rows, { lt1: 160 });
    const rolling = rollingMedianSeries(c.runs);
    const t = computeTrendWindows(c.runs, rolling, c.refHr);
    expect(t.start).not.toBeNull();
    expect(t.now).not.toBeNull();
    expect(t.peak).not.toBeNull();
    expect(t.yearAgo).not.toBeNull();
    expect(t.start!.pace_sec_per_km).toBeCloseTo(420, 0);
    expect(t.peak!.pace_sec_per_km).toBeCloseTo(330, 0);
    expect(t.now!.pace_sec_per_km).toBeCloseTo(345, 0);
    expect(t.now!.ef).toBeLessThan(t.peak!.ef);
    expect(t.now!.ef).toBeGreaterThan(t.start!.ef);
  });

  test("year-ago is null when there is no data there", () => {
    const rows = daily("2026-01-01", 120).filter((_, i) => i % 2 === 0);
    const c = selectAerobicCohort(rows, { lt1: 160 });
    const t = computeTrendWindows(c.runs, rollingMedianSeries(c.runs), c.refHr);
    expect(t.yearAgo).toBeNull();
    expect(t.now).not.toBeNull();
  });
});

describe("monthlyRows + buildSummary", () => {
  test("monthly rows carry temperature, sub-zero and data-quality counts; summary names the confounders", () => {
    const rows = [
      ...daily("2026-01-01", 10, i => ({ temp_c: -8, stream_ef: 0.019 })),
      ...daily("2026-02-01", 10, i => ({ temp_c: 2, stream_ef: i === 0 ? null : 0.02 })),
    ];
    const c = selectAerobicCohort(rows, { lt1: 160 });
    const months = monthlyRows(c.runs, c.refHr, { "2026-01": 250, "2026-02": 180, "2026-03": 90 });
    expect(months.map(m => m.month)).toEqual(["2026-01", "2026-02", "2026-03"]);
    expect(months[0].subzero).toBe(10);
    expect(months[0].avg_temp_c).toBe(-8);
    expect(months[0].km).toBe(250);
    expect(months[1].raw_ef).toBe(1);
    expect(months[2].n).toBe(0);
    expect(months[2].km).toBe(90);

    const rolling = rollingMedianSeries(c.runs);
    const trend = computeTrendWindows(c.runs, rolling, c.refHr);
    const text = buildSummary({ cohort: c, rolling, trend, months, annotations: [], horizonMonths: 3 });
    expect(text).toContain("trailing 90-day windows");
    expect(text).toContain("10 cohort runs were at or below 0°C");
    expect(text).toContain("1 run(s) have no stream analysis");
    expect(text).toContain("No events marked");
    expect(text).toContain("no comparable easy runs");
  });
});

describe("heat prior", () => {
  test("off by default, applies +0.2%/°C above 10°C only when asked, never in the cold", () => {
    const { heatAdjustFactor } = require("../aerobic-chart.js");
    expect(heatAdjustFactor(null)).toBe(1);
    expect(heatAdjustFactor(-8)).toBe(1);
    expect(heatAdjustFactor(10)).toBe(1);
    expect(heatAdjustFactor(20)).toBeCloseTo(1.02, 6);

    const rows = [run("2026-07-01", { temp_c: 25 }), run("2026-07-02", { temp_c: 5 }), run("2026-07-03", { temp_c: null })];
    const off = selectAerobicCohort(rows, { lt1: 160 });
    expect(off.runs.map(r => r.heat_adj_pct)).toEqual([0, 0, 0]);

    const on = selectAerobicCohort(rows, { lt1: 160, heatAdjust: true });
    expect(on.runs[0].heat_adj_pct).toBeCloseTo(3, 6);
    expect(on.runs[0].ef).toBeCloseTo(off.runs[0].ef * 1.03, 6);
    expect(on.runs[1].heat_adj_pct).toBe(0);
    expect(on.runs[2].heat_adj_pct).toBe(0);
  });

  test("summary labels the series and reports the with-prior check when off", () => {
    const rows = daily("2026-05-01", 120, i => ({ temp_c: i < 60 ? 18 : 6 })).filter((_, i) => i % 2 === 0);
    const c = selectAerobicCohort(rows, { lt1: 160 });
    const rolling = rollingMedianSeries(c.runs);
    const trend = computeTrendWindows(c.runs, rolling, c.refHr);
    const alt = selectAerobicCohort(rows, { lt1: 160, heatAdjust: true });
    const altTrend = computeTrendWindows(alt.runs, rollingMedianSeries(alt.runs), alt.refHr);
    const months = monthlyRows(c.runs, c.refHr, {});

    const off = buildSummary({ cohort: c, rolling, trend, months, annotations: [], horizonMonths: 4, heatAdjusted: false, heatAlternative: altTrend });
    expect(off).toContain("Heat prior NOT applied");
    expect(off).toContain("Heat prior check");
    expect(off).toContain("With it applied, now vs peak would be");

    const on = buildSummary({ cohort: alt, rolling: rollingMedianSeries(alt.runs), trend: altTrend, months: monthlyRows(alt.runs, alt.refHr, {}), annotations: [], horizonMonths: 4, heatAdjusted: true });
    expect(on).toContain("Heat prior APPLIED");
    expect(on).not.toContain("Heat prior check");
  });
});

describe("centredMedianSeries", () => {
  test("peaks where the good running was and flags the edges as provisional", () => {
    const { centredMedianSeries } = require("../aerobic-chart.js");
    // 300 days: slow, then 60 fast days in the middle (day 120-179), then slow
    const rows = daily("2026-01-01", 300, i => ({ pace_sec_per_km: i >= 120 && i < 180 ? 300 : 360 })).filter((_, i) => i % 2 === 0);
    const c = selectAerobicCohort(rows, { lt1: 160 });
    const centred = centredMedianSeries(c.runs, 90);
    const trailing = rollingMedianSeries(c.runs, 90);
    const peakC = centred.reduce((a: any, b: any) => (b.ef > a.ef ? b : a));
    const peakT = trailing.reduce((a, b) => (b.ef > a.ef ? b : a));
    // centred peak sits inside the fast block; the trailing peak lands later,
    // once the fast runs make up most of a window that ends on that date
    expect(peakC.date >= "2026-05-01" && peakC.date <= "2026-06-29").toBe(true);
    expect(peakT.date > peakC.date).toBe(true);
    expect(centred[0].provisional).toBe(true);
    expect(centred[centred.length - 1].provisional).toBe(true);
    const mid = centred.find((p: any) => p.date === "2026-05-31")!; // every second day from Jan 1, so even day numbers only
    expect(mid.provisional).toBe(false);
  });
});
