import { getDb } from "./activities-db.js";
import { getDataDir } from "./paths.js";
import { loadTrainingZones } from "./training-zones.js";
import { formatPaceRaw } from "./format.js";
import open from "open";
import * as path from "path";
import * as fs from "fs/promises";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AerobicRunRow {
  date: string;
  avg_hr: number;
  avg_speed: number; // m/s
  pace_sec_per_km: number;
  distance_km: number;
  run_type: string;
  iso_week: string; // "YYYY-WNN"
  day_of_week: number; // 0=Sun..6=Sat
}

interface AerobicChartData {
  runs: AerobicRunRow[];
  lt1: number | null;
  months: number;
  generated_at: string;
}

export interface ChartResult {
  outputPath: string;
  runCount: number;
  summary: string;
}

// ---------------------------------------------------------------------------
// Data query (pure DB access, testable)
// ---------------------------------------------------------------------------

export function queryAerobicData(months: number): AerobicRunRow[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT
        date(a.start_date_local) as date,
        a.average_heartrate as avg_hr,
        a.average_speed as avg_speed,
        a.moving_time * 1000.0 / a.distance as pace_sec_per_km,
        a.distance / 1000.0 as distance_km,
        COALESCE(aa.run_type, a.run_type, 'unknown') as run_type,
        strftime('%Y', a.start_date_local) || '-W' || strftime('%W', a.start_date_local) as iso_week,
        CAST(strftime('%w', a.start_date_local) AS INTEGER) as day_of_week
      FROM activities a
      LEFT JOIN activity_analysis aa ON aa.activity_id = a.id
      WHERE a.type = 'Run'
        AND (a.trainer = 0 OR a.trainer IS NULL)
        AND a.average_heartrate IS NOT NULL
        AND a.distance > 4000
        AND date(a.start_date_local) >= date('now', '-' || ? || ' months')
      ORDER BY a.start_date_local ASC`
    )
    .all(months) as AerobicRunRow[];

  return rows;
}

// ---------------------------------------------------------------------------
// Chart summary builder (pure, no side effects)
// ---------------------------------------------------------------------------

const HARD_TYPES = new Set(["tempo", "intervals", "hill_repeat", "fartlek", "race", "threshold"]);

function avg(arr: number[]): number {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

/** Least-squares slope + intercept for y = a*x + b. Returns zeros if <2 points. */
function linearFit(xs: number[], ys: number[]): { slope: number; intercept: number } {
  const n = xs.length;
  if (n < 2) return { slope: 0, intercept: ys[0] ?? 0 };
  const sx = xs.reduce((a, b) => a + b, 0);
  const sy = ys.reduce((a, b) => a + b, 0);
  const sxy = xs.reduce((a, x, i) => a + x * ys[i], 0);
  const sxx = xs.reduce((a, x) => a + x * x, 0);
  const denom = n * sxx - sx * sx;
  if (denom === 0) return { slope: 0, intercept: sy / n };
  const slope = (n * sxy - sx * sy) / denom;
  return { slope, intercept: (sy - slope * sx) / n };
}

function buildSummary(runs: AerobicRunRow[], months: number): string {
  const easyRuns = runs.filter((r) => !HARD_TYPES.has(r.run_type) && r.avg_hr <= 155);

  if (easyRuns.length === 0) {
    return `No easy/Z2 runs found in the last ${months} months.`;
  }

  // Pre-compute EF per run — single source of truth
  const enriched = easyRuns.map((r) => ({ ...r, ef: (r.avg_speed * 60) / r.avg_hr }));

  // ---- Monthly aggregates (Panel 2 diamonds, general trend) ----
  const byMonth: Record<string, typeof enriched> = {};
  for (const r of enriched) {
    const m = r.date.slice(0, 7);
    (byMonth[m] ??= []).push(r);
  }
  const monthKeys = Object.keys(byMonth).sort();

  const monthStats = monthKeys.map((m) => {
    const d = byMonth[m];
    return {
      month: m,
      count: d.length,
      avgHr: avg(d.map((r) => r.avg_hr)),
      avgPace: avg(d.map((r) => r.pace_sec_per_km)),
      avgEf: avg(d.map((r) => r.ef)),
    };
  });

  const first = monthStats[0];
  const last = monthStats[monthStats.length - 1];
  const efPct = ((last.avgEf - first.avgEf) / first.avgEf) * 100;

  // ---- Panel 3: pace at fixed HR band (140-150 bpm) ----
  const band = enriched.filter((r) => r.avg_hr >= 140 && r.avg_hr <= 150);
  const bandByMonth: Record<string, typeof enriched> = {};
  for (const r of band) {
    const m = r.date.slice(0, 7);
    (bandByMonth[m] ??= []).push(r);
  }

  // ---- Panel 4: monthly HR->pace regression slope ----
  // slope in (sec/km) per bpm — shallower means more HR headroom per unit pace
  const monthRegressions = monthKeys
    .map((m) => {
      const d = byMonth[m];
      if (d.length < 4) return null;
      const fit = linearFit(
        d.map((r) => r.avg_hr),
        d.map((r) => r.pace_sec_per_km)
      );
      return { month: m, slope: fit.slope, count: d.length };
    })
    .filter((x): x is { month: string; slope: number; count: number } => x !== null);

  // ---- Highlights ----
  const bestEf = enriched.reduce((a, b) => (a.ef > b.ef ? a : b));
  const fastestInBand = band.length > 0
    ? band.reduce((a, b) => (a.pace_sec_per_km < b.pace_sec_per_km ? a : b))
    : null;
  const mostRecent = enriched[enriched.length - 1];

  // ---- Build output ----
  const lines: string[] = [];

  lines.push(
    `Aerobic development: ${enriched.length} easy runs over ${monthKeys.length} months (${monthKeys[0]} -> ${monthKeys[monthKeys.length - 1]})`,
    ``,
    `Overall trend:`,
    `  Efficiency Factor: ${efPct >= 0 ? "+" : ""}${efPct.toFixed(1)}% (${first.avgEf.toFixed(2)} -> ${last.avgEf.toFixed(2)} m/min per bpm)`,
    `  Easy pace: ${formatPaceRaw(first.avgPace)}/km -> ${formatPaceRaw(last.avgPace)}/km`,
    `  Avg HR: ${first.avgHr.toFixed(0)} -> ${last.avgHr.toFixed(0)} bpm`,
    ``,
    `Monthly breakdown (panel 2 diamonds):`
  );
  for (const s of monthStats) {
    lines.push(
      `  ${s.month}: ${s.count} runs, HR ${s.avgHr.toFixed(0)} bpm, pace ${formatPaceRaw(s.avgPace)}/km, EF ${s.avgEf.toFixed(2)}`
    );
  }

  lines.push(``, `Panel 3 — Pace at HR 140-150 band (${band.length} runs in band):`);
  if (band.length === 0) {
    lines.push(`  No runs in the 140-150 bpm band.`);
  } else {
    for (const m of monthKeys) {
      const bm = bandByMonth[m];
      if (!bm || bm.length === 0) continue;
      const p = avg(bm.map((r) => r.pace_sec_per_km));
      lines.push(`  ${m}: ${bm.length} runs, avg pace ${formatPaceRaw(p)}/km`);
    }
  }

  lines.push(``, `Panel 4 — Monthly HR->pace regression slope (sec/km per bpm, lower = fitter):`);
  if (monthRegressions.length === 0) {
    lines.push(`  Not enough runs per month to compute regressions.`);
  } else {
    for (const r of monthRegressions) {
      const sign = r.slope >= 0 ? "+" : "";
      lines.push(`  ${r.month}: ${sign}${r.slope.toFixed(1)} sec/km per bpm (${r.count} runs)`);
    }
  }

  lines.push(
    ``,
    `Highlights:`,
    `  Best EF run: ${bestEf.date} @ ${formatPaceRaw(bestEf.pace_sec_per_km)}/km, HR ${bestEf.avg_hr.toFixed(0)} (EF ${bestEf.ef.toFixed(2)})`
  );
  if (fastestInBand) {
    lines.push(
      `  Fastest in HR 140-150 band: ${fastestInBand.date} @ ${formatPaceRaw(fastestInBand.pace_sec_per_km)}/km, HR ${fastestInBand.avg_hr.toFixed(0)}`
    );
  }
  lines.push(
    `  Most recent easy run: ${mostRecent.date} @ ${formatPaceRaw(mostRecent.pace_sec_per_km)}/km, HR ${mostRecent.avg_hr.toFixed(0)} (EF ${mostRecent.ef.toFixed(2)})`
  );

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Python chart script (embedded)
// ---------------------------------------------------------------------------

const PYTHON_CHART_SCRIPT = `
import sys, json
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import matplotlib.dates as mdates
import numpy as np
from matplotlib.ticker import FuncFormatter
from datetime import datetime

try:
    from scipy.stats import linregress
except ImportError:
    # Minimal numpy fallback — returns a 5-tuple matching scipy's shape
    # so call sites can destructure (slope, intercept, r, p, se).
    def linregress(x, y):
        x = np.asarray(x, dtype=float)
        y = np.asarray(y, dtype=float)
        n = len(x)
        if n < 2:
            return 0.0, float(y[0]) if n else 0.0, 0.0, 0.0, 0.0
        sx = np.sum(x); sy = np.sum(y)
        sxy = np.sum(x * y); sxx = np.sum(x * x)
        denom = n * sxx - sx * sx
        if denom == 0:
            return 0.0, float(sy / n), 0.0, 0.0, 0.0
        slope = (n * sxy - sx * sy) / denom
        intercept = (sy - slope * sx) / n
        return float(slope), float(intercept), 0.0, 0.0, 0.0

# Read data from stdin
data = json.loads(sys.stdin.read())
output_path = sys.argv[1]
runs = data['runs']
lt1 = data.get('lt1')

if not runs:
    print("ERROR:No runs to chart", file=sys.stderr)
    sys.exit(1)

# Classify runs
HARD_TYPES = {'tempo', 'intervals', 'hill_repeat', 'fartlek', 'race', 'threshold'}
easy = [r for r in runs if r['run_type'] not in HARD_TYPES and r['avg_hr'] <= 155]
hard = [r for r in runs if r['run_type'] in HARD_TYPES or r['avg_hr'] > 155]

if not easy:
    print("ERROR:No easy/Z2 runs found", file=sys.stderr)
    sys.exit(1)

# Parse dates
for r in easy + hard:
    r['_date'] = mdates.date2num(datetime.strptime(r['date'], '%Y-%m-%d'))
    r['_pace_min'] = r['pace_sec_per_km'] / 60.0
    r['_ef'] = (r['avg_speed'] * 60) / r['avg_hr']
    r['_month'] = r['date'][:7]

dates_e = np.array([r['_date'] for r in easy])
hrs_e = np.array([r['avg_hr'] for r in easy])
paces_e = np.array([r['_pace_min'] for r in easy])
kms_e = np.array([r['distance_km'] for r in easy])
efs_e = np.array([r['_ef'] for r in easy])
months_e = [r['_month'] for r in easy]

dates_h = np.array([r['_date'] for r in hard]) if hard else np.array([])
hrs_h = np.array([r['avg_hr'] for r in hard]) if hard else np.array([])
paces_h = np.array([r['_pace_min'] for r in hard]) if hard else np.array([])

# LOWESS implementation
def lowess(x, y, frac=0.3):
    n = len(x)
    idx = np.argsort(x)
    xs, ys = x[idx], y[idx]
    window = max(int(n * frac), 5)
    out = np.zeros(n)
    for i in range(n):
        lo = max(0, i - window // 2)
        hi = min(n, i + window // 2 + 1)
        if hi - lo < 3:
            lo = max(0, hi - 3)
        w = np.exp(-0.5 * ((xs[lo:hi] - xs[i]) / (xs[hi-1] - xs[lo] + 1e-10))**2)
        c = np.polyfit(xs[lo:hi] - xs[i], ys[lo:hi], min(2, hi-lo-1), w=w)
        out[i] = np.polyval(c, 0)
    return xs, out

def pace_fmt(x, pos):
    m = int(x)
    s = int((x - m) * 60)
    return f'{m}:{s:02d}'

# Month helpers
month_order = sorted(set(months_e))
def month_label(m):
    return datetime.strptime(m, '%Y-%m').strftime('%b')

C_HR = '#e74c3c'
C_PACE = '#2980b9'
C_TREND = '#2c3e50'
C_MONTHLY = '#e74c3c'
BG = '#fafafa'

# --- Weekly selection for panel 1: up to 2 easy runs per week ---
weeks = {}
for r in easy:
    wk = r.get('iso_week', '')
    if wk not in weeks:
        weeks[wk] = []
    weeks[wk].append(r)

weekly = []
for wk in sorted(weeks):
    candidates = sorted(weeks[wk], key=lambda r: abs(r['distance_km'] - 9.5))
    weekly.extend(candidates[:2])

w_dates = np.array([r['_date'] for r in weekly])
w_hrs = np.array([r['avg_hr'] for r in weekly])
w_paces = np.array([r['_pace_min'] for r in weekly])

# ===================== FIGURE =====================
fig = plt.figure(figsize=(15, 20))
gs = fig.add_gridspec(4, 1, hspace=0.35)

# --- Panel 1: Weekly Z2 HR + Pace ---
ax1 = fig.add_subplot(gs[0])
ax1.set_facecolor(BG)
ax1.set_ylabel('Average HR (bpm)', color=C_HR, fontsize=11)
l1 = ax1.plot(w_dates, w_hrs, 'o', color=C_HR, markersize=5, alpha=0.4, label='Avg HR')
xs1, ys1 = lowess(w_dates, w_hrs, 0.25)
ax1.plot(xs1, ys1, '-', color=C_HR, linewidth=2.5, alpha=0.8)
ax1.tick_params(axis='y', labelcolor=C_HR)
if lt1:
    z2_low = round(lt1 * 0.88)
    ax1.axhspan(z2_low, lt1, alpha=0.06, color='#27ae60')
    ax1.axhline(z2_low, color='#27ae60', ls='--', alpha=0.2, lw=1)
    ax1.axhline(lt1, color='#27ae60', ls='--', alpha=0.2, lw=1)
ax1.set_ylim(118, 162)

ax1b = ax1.twinx()
ax1b.set_ylabel('Pace (min/km)', color=C_PACE, fontsize=11)
l2 = ax1b.plot(w_dates, w_paces, 's', color=C_PACE, markersize=5, alpha=0.4, label='Avg Pace')
xs1p, ys1p = lowess(w_dates, w_paces, 0.25)
ax1b.plot(xs1p, ys1p, '-', color=C_PACE, linewidth=2.5, alpha=0.8)
ax1b.tick_params(axis='y', labelcolor=C_PACE)
ax1b.yaxis.set_major_formatter(FuncFormatter(pace_fmt))
ax1b.invert_yaxis()

lines = l1 + l2
labels = [l.get_label() for l in lines]
ax1.legend(lines, labels, loc='upper left', fontsize=9)
ax1.set_title(f'Weekly Z2 Runs ({len(weekly)} runs, up to 2/week)', fontsize=13, fontweight='bold')
ax1.xaxis.set_major_formatter(mdates.DateFormatter('%b'))
ax1.xaxis.set_major_locator(mdates.MonthLocator())
ax1.grid(True, alpha=0.12)
ax1.text(0.99, 0.02, 'green band = Z2  |  pace axis inverted (up = faster)',
         transform=ax1.transAxes, fontsize=8, alpha=0.4, ha='right')

# --- Panel 2: Efficiency Factor ---
ax2 = fig.add_subplot(gs[1])
ax2.set_facecolor(BG)
ax2.scatter(dates_e, efs_e, c='#5b9bd5', s=kms_e * 3, alpha=0.3, edgecolors='white', linewidth=0.3, zorder=2)

xs2, ys2 = lowess(dates_e, efs_e, 0.25)
ax2.plot(xs2, ys2, '-', color=C_TREND, linewidth=3, zorder=4, label='Trend')

slope, intercept, _, _, _ = linregress(dates_e, efs_e)
ef_start = intercept + slope * dates_e[0]
ef_end = intercept + slope * dates_e[-1]
pct_ef = 100 * (ef_end - ef_start) / ef_start

y_fit = intercept + slope * dates_e
residual_std = np.std(efs_e - y_fit)
ax2.fill_between(xs2, ys2 - residual_std, ys2 + residual_std, alpha=0.07, color=C_TREND, zorder=1)

for m in month_order:
    mask = np.array([ms == m for ms in months_e])
    if mask.sum() > 0:
        ax2.plot(np.mean(dates_e[mask]), np.mean(efs_e[mask]), 'D', color=C_MONTHLY,
                 markersize=7, zorder=5, markeredgecolor='white', markeredgewidth=1)
        lbl = month_label(m)
        ax2.annotate(lbl, (np.mean(dates_e[mask]), np.mean(efs_e[mask])),
                     textcoords='offset points', xytext=(0, 10), fontsize=8, fontweight='bold',
                     color=C_MONTHLY, ha='center', zorder=6)

ax2.set_ylabel('Efficiency Factor (m/min per bpm)', fontsize=11)
ax2.set_title(f'Aerobic Efficiency Factor  |  {pct_ef:+.1f}% over period', fontsize=13, fontweight='bold')
ax2.xaxis.set_major_formatter(mdates.DateFormatter('%b'))
ax2.xaxis.set_major_locator(mdates.MonthLocator())
ax2.legend(loc='lower right', fontsize=9)
ax2.grid(True, alpha=0.12)
ax2.text(0.01, 0.02, 'higher = faster at same HR  |  dot size = distance  |  diamond = monthly avg',
         transform=ax2.transAxes, fontsize=8, alpha=0.4)

# --- Panel 3: Pace at Fixed HR Band ---
ax3 = fig.add_subplot(gs[2])
ax3.set_facecolor(BG)

band_mask = (hrs_e >= 140) & (hrs_e <= 150)
band_dates = dates_e[band_mask]
band_paces = paces_e[band_mask]
band_kms = kms_e[band_mask]
band_hrs = hrs_e[band_mask]
band_months = [months_e[i] for i in range(len(months_e)) if band_mask[i]]

wide_mask = ~band_mask
ax3.scatter(dates_e[wide_mask], paces_e[wide_mask], c='#bdc3c7', s=20, alpha=0.25, zorder=1, label='Outside 140-150 band')

if len(band_dates) > 2:
    scatter3 = ax3.scatter(band_dates, band_paces, c=band_hrs, cmap='RdYlGn_r',
                            s=band_kms * 4, alpha=0.55, edgecolors='white', linewidth=0.4,
                            vmin=140, vmax=150, zorder=3, label='HR 140-150 bpm')
    plt.colorbar(scatter3, ax=ax3, shrink=0.5, pad=0.02).set_label('Avg HR (bpm)', fontsize=9)

    if len(band_dates) > 5:
        xs3, ys3 = lowess(band_dates, band_paces, 0.3)
        ax3.plot(xs3, ys3, '-', color=C_TREND, linewidth=3, zorder=4, label='Trend')

        for m in month_order:
            m_mask = np.array([band_months[i] == m for i in range(len(band_months))])
            if m_mask.sum() > 0:
                ax3.plot(np.mean(band_dates[m_mask]), np.mean(band_paces[m_mask]), 'D', color=C_MONTHLY,
                         markersize=7, zorder=5, markeredgecolor='white', markeredgewidth=1)
                lbl = month_label(m)
                ax3.annotate(lbl, (np.mean(band_dates[m_mask]), np.mean(band_paces[m_mask])),
                             textcoords='offset points', xytext=(0, -13), fontsize=8, fontweight='bold',
                             color=C_MONTHLY, ha='center', zorder=6)

    slope3, _, _, _, _ = linregress(band_dates, band_paces)
    total_pace = slope3 * (band_dates.max() - band_dates.min())
    ax3.set_title(f'Pace at Fixed HR Band (140-150 bpm)  |  {total_pace * 60:+.0f} sec/km', fontsize=13, fontweight='bold')
else:
    ax3.set_title('Pace at Fixed HR Band (140-150 bpm)  |  insufficient data', fontsize=13, fontweight='bold')

ax3.yaxis.set_major_formatter(FuncFormatter(pace_fmt))
ax3.invert_yaxis()
ax3.set_ylabel('Pace (min/km)', fontsize=11)
ax3.xaxis.set_major_formatter(mdates.DateFormatter('%b'))
ax3.xaxis.set_major_locator(mdates.MonthLocator())
ax3.legend(loc='lower right', fontsize=9)
ax3.grid(True, alpha=0.12)
ax3.text(0.01, 0.02, 'only runs with avg HR 140-150 bpm  |  diamond = monthly avg',
         transform=ax3.transAxes, fontsize=8, alpha=0.4)

# --- Panel 4: Monthly HR-Pace Regression ---
ax4 = fig.add_subplot(gs[3])
ax4.set_facecolor(BG)

colors = plt.colormaps['viridis'](np.linspace(0.1, 0.95, len(month_order)))

for i, m in enumerate(month_order):
    mask = np.array([ms == m for ms in months_e])
    m_hrs = hrs_e[mask]
    m_paces = paces_e[mask]
    lbl = month_label(m)
    c = colors[i]
    ax4.scatter(m_hrs, m_paces, color=c, s=35, alpha=0.4, edgecolors='white', linewidth=0.3, zorder=2)
    if len(m_hrs) >= 4:
        sl, ic, _, _, _ = linregress(m_hrs, m_paces)
        hr_range = np.array([125, 158])
        ax4.plot(hr_range, ic + sl * hr_range, '-', color=c, linewidth=2.5, alpha=0.85,
                 label=f'{lbl} ({len(m_hrs)} runs)', zorder=3)

ax4.yaxis.set_major_formatter(FuncFormatter(pace_fmt))
ax4.invert_yaxis()
ax4.set_xlabel('Average Heart Rate (bpm)', fontsize=11)
ax4.set_ylabel('Pace (min/km)', fontsize=11)
ax4.set_title('HR -> Pace Relationship by Month', fontsize=13, fontweight='bold')
ax4.legend(fontsize=9, loc='lower left', ncol=2)
ax4.grid(True, alpha=0.12)
ax4.set_xlim(124, 158)
ax4.text(0.01, 0.02, 'regression line shifting up = faster at same HR  |  color: dark=old, light=recent',
         transform=ax4.transAxes, fontsize=8, alpha=0.4)

fig.savefig(output_path, dpi=150, bbox_inches='tight')
print(f"OK:{output_path}")
`;

// ---------------------------------------------------------------------------
// Chart generation orchestrator
// ---------------------------------------------------------------------------

export async function generateAerobicChart(
  months: number = 8
): Promise<ChartResult> {
  const runs = queryAerobicData(months);

  if (runs.length === 0) {
    return {
      outputPath: "",
      runCount: 0,
      summary: `No runs found in the last ${months} months. Sync Strava data first.`,
    };
  }

  // Load LT1 for Z2 boundary annotation
  const zones = await loadTrainingZones();
  const lt1 = zones?.hr.confirmed ? zones.hr.lt1 : null;

  const chartData: AerobicChartData = {
    runs,
    lt1,
    months,
    generated_at: new Date().toISOString(),
  };

  // Ensure output directory
  const chartsDir = path.join(getDataDir(), "charts");
  await fs.mkdir(chartsDir, { recursive: true });

  const timestamp = new Date().toISOString().slice(0, 10);
  const outputPath = path.join(chartsDir, `aerobic-${timestamp}.png`);

  // Spawn Python
  const proc = Bun.spawn(["python3", "-c", PYTHON_CHART_SCRIPT, outputPath], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  proc.stdin.write(JSON.stringify(chartData));
  proc.stdin.end();

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    const errMsg = stderr.trim() || stdout.trim() || "Unknown error";
    if (errMsg.includes("No module named")) {
      throw new Error(
        `Python dependency missing. Install with: pip3 install matplotlib numpy scipy\n\n${errMsg}`
      );
    }
    throw new Error(`Chart generation failed (exit ${exitCode}): ${errMsg}`);
  }

  // Auto-open on macOS
  try {
    await open(outputPath);
  } catch {
    // Non-fatal — chart still exists on disk
  }

  const summary = buildSummary(runs, months);

  return {
    outputPath,
    runCount: runs.length,
    summary,
  };
}
