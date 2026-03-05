# Stream Analysis Reference

Deterministic per-second stream analysis engine for running activities. Computes training metrics from Strava GPS/HR/cadence streams and stores compact results in SQLite.

Source: `src/utils/stream-analysis.ts`

## Architecture

```
Strava streams (per-second arrays)
  │
  ├─ time[]      (seconds since start)
  ├─ distance[]  (cumulative meters)
  ├─ heartrate[] (bpm, optional)
  ├─ grade_smooth[] (%, optional)
  └─ cadence[]   (spm, optional)
        │
        ▼
  deriveSpeed() → speed[] (m/s)
        │
        ▼
  Smoothing: 30s rolling avg (pace), 10s rolling avg (HR)
        │
  ┌─────┼─────────────────┐───────────────┐
  ▼     ▼                 ▼               ▼
Tier 1          Tier 2          Tier 3
HR zones        NGP             Phase detection
Cardiac drift   Fatigue index   Interval detection
Pace CV         Cadence drift
Split type      Efficiency factor
TRIMP
        │
        ▼
  StreamAnalysisResult → SQLite (activity_stream_analysis)
```

All functions are pure (no DB, no async). The main entry point `computeStreamAnalysis()` orchestrates the pipeline and returns a `StreamAnalysisResult`.

## Metrics

### Tier 1: Core Metrics

#### HR Zone Distribution

Time spent in each of 5 Friel-style zones based on lactate thresholds.

| Zone | Boundary | Description |
|------|----------|-------------|
| Z1 | HR < LT1 * 0.88 | Recovery |
| Z2 | LT1 * 0.88 to LT1 | Aerobic |
| Z3 | LT1 to LT2 | Tempo |
| Z4 | LT2 to maxHR * 0.97 | Threshold |
| Z5 | >= maxHR * 0.97 | VO2max / Anaerobic |

**Requires:** heartrate stream + hrZones
**Null when:** no HR data or no zone config

#### Cardiac Drift (Pa:HR Decoupling)

Percentage drop in efficiency factor (speed/HR) between the first and second half of the run, split by distance.

```
EF = avg_speed / avg_HR
drift = ((EF_first_half - EF_second_half) / EF_first_half) * 100
```

| Range | Interpretation |
|-------|----------------|
| < 5% | Well coupled (aerobic ceiling not reached) |
| 5-10% | Normal drift |
| > 10% | High drift (pushed above aerobic threshold, dehydration, or heat) |

**Requires:** heartrate + speed streams, movingTime >= 600s
**Null when:** run < 10 min, no HR data

#### Pace Variability (CV)

Coefficient of variation of smoothed speed: `(stddev / mean) * 100`.

Lower = more even pacing. A CV < 5% indicates metronomic pacing; > 15% suggests interval-like variability.

**Requires:** >= 30 moving samples
**Null when:** too few valid samples

#### Split Type

Classifies the run based on second-half vs first-half average speed ratio:

| Ratio | Classification |
|-------|----------------|
| > 1.02 | Negative split (faster second half) |
| < 0.98 | Positive split (slower second half) |
| 0.98 - 1.02 | Even |

**Requires:** total distance >= 1km
**Null when:** run too short

#### TRIMP (Training Impulse)

Banister TRIMPexp — exponentially weighted training load that accounts for both duration and intensity.

```
TRIMP = sum((dt/60) * HRr * 0.64 * e^(1.92 * HRr))
HRr = (HR - HRrest) / (HRmax - HRrest), clamped to [0, 1]
HRrest = LT1 * 0.65 (estimated)
```

The 1.92 constant is the male default (female = 1.67, not yet configurable).

| Range | Typical session |
|-------|-----------------|
| 30-60 | Easy 30-40 min run |
| 60-120 | Moderate tempo/long run |
| 120-200 | Hard workout or long race |
| 200+ | Marathon or ultra-distance effort |

**Requires:** heartrate stream + hrZones with max_hr > estimated resting HR
**Null when:** no HR data, no zones, or degenerate zone config

### Tier 2: Advanced Metrics

#### Normalized Graded Pace (NGP)

Grade-adjusted pace using Minetti 2002 energy cost polynomial, normalized via Coggan's NP algorithm.

Steps:
1. Per-second GAP-adjusted speed: `speed[i] * minettiGapFactor(grade[i])`
2. 30-second rolling average
3. Fourth-power mean → fourth root (penalizes variability like NP in cycling)
4. Convert m/s → sec/km

The Minetti polynomial models energy cost as a function of grade:
```
Cr(g) = 155.4g^5 - 30.4g^4 - 43.3g^3 + 46.3g^2 + 19.5g + 3.6
```
where g is grade as a fraction (not percent), clamped to [-0.45, 0.45].

On flat terrain NGP equals actual pace. Uphill NGP is faster (acknowledges harder effort). Moderate downhill NGP is slower (easier effort). Steep downhill NGP increases again (braking is costly).

**Requires:** grade_smooth stream, >= 60 data points
**Null when:** no grade data or activity too short

#### Fatigue Index

Percentage effort-speed difference between first 75% and last 25% of run distance. Uses GAP-adjusted speed when grade data is available.

```
fatigue = ((avg_effort_first75 - avg_effort_last25) / avg_effort_first75) * 100
```

| Range | Interpretation |
|-------|----------------|
| < 0% | Negative (sped up at end) |
| 0-3% | Minimal fatigue |
| 3-8% | Moderate fatigue |
| > 8% | Significant fade |

**Requires:** total distance >= 2km
**Null when:** run too short

#### Cadence Drift

Difference in time-weighted average cadence between the first third and last third of the run (spm). Middle third excluded to sharpen the signal.

Positive = cadence increased; negative = cadence dropped (common sign of fatigue).

**Requires:** cadence stream, total time >= 600s
**Null when:** no cadence data or run < 10 min

#### Efficiency Factor (EF)

Ratio of speed to heart rate, using NGP-derived speed:

```
EF = (1000 / NGP_sec_per_km) / avg_HR
```

Higher EF = better aerobic efficiency. Tracking EF over weeks reveals fitness gains (same pace at lower HR, or faster pace at same HR).

**Requires:** grade_smooth stream + heartrate stream + hrZones
**Null when:** NGP is null or avg HR is 0

### Tier 3: Phase & Interval Detection

#### Phase Detection

State machine segments the activity into phases using hysteresis on **effort speed** (GAP-adjusted when grade data is available, raw speed otherwise):

| Phase | Condition |
|-------|-----------|
| Stopped | raw speed < 0.3 m/s (always checked on raw, not GAP) |
| Work | effort speed >= easySpeed * 1.05 |
| Easy/Recovery | effort speed < easySpeed * 0.95 |
| Hysteresis band | Between thresholds → maintain current phase |

Where `easySpeed = 1000 / easyPaceRef` (athlete's easy pace in m/s).

**Why GAP-adjusted speed?** On hilly terrain, raw speed is inversely correlated with effort. A slow uphill climb (15:00/km at 30% grade) has a GAP of ~2:14/km — correctly classified as "work." A fast downhill (5:00/km at -30% grade) has a low GAP — correctly classified as "recovery." On flat terrain, GAP = raw speed, so behavior is unchanged.

Post-processing:
- Phases shorter than 60s (except stopped) merge into neighbors
- First "easy" segment covering < 15% of total distance → **warmup**
- Last "easy" segment starting after 85% of total distance → **cooldown**
- Other "easy" segments → **recovery**

Each phase includes: start_s, end_s, distance_m, avg_pace_sec_per_km (actual pace, not GAP), avg_hr, elevation_gain_m, elevation_loss_m.

**Returns:** empty array for activities < 10 data points.

#### Interval Detection

Pairs consecutive work + recovery phases into structured interval reps. Each rep includes work distance, pace, HR, and optional rest duration.

**Requires:** >= 2 work phases detected
**Spurious filter:** If one work phase holds >80% of total work distance, returns empty (continuous run, not intervals).
**Returns:** empty array for continuous (non-interval) runs.

## Smoothing Standards

| Stream | Method | Window | Rationale |
|--------|--------|--------|-----------|
| Speed/Pace | Time-based rolling avg | 30s | Industry standard (TrainingPeaks, Strava) |
| Heart rate | Time-based rolling avg | 10s | Reduces beat-to-beat noise while preserving trends |
| Altitude | Distance-based rolling avg | 50-100m | GPS altitude noise correlates with distance, not time |

## Data Filtering

All metrics apply consistent sample-level filtering:

| Condition | Action |
|-----------|--------|
| `speed < 0.5 m/s` | Excluded as "stopped" (except HR zone accumulation) |
| `dt <= 0` (duplicate timestamp) | Skipped |
| `dt > 30s` (gap/pause) | Skipped (prevents pause time from distorting averages) |
| `hr <= 0` | Skipped in HR calculations |
| `cadence <= 0` | Skipped in cadence calculations |

## Database Schema

```sql
CREATE TABLE activity_stream_analysis (
  activity_id     INTEGER PRIMARY KEY REFERENCES activities(id),
  hr_zone1_s      INTEGER,
  hr_zone2_s      INTEGER,
  hr_zone3_s      INTEGER,
  hr_zone4_s      INTEGER,
  hr_zone5_s      INTEGER,
  hr_total_s      INTEGER,
  cardiac_drift_pct   REAL,
  pace_variability_cv REAL,
  split_type          TEXT,    -- "negative" | "positive" | "even"
  trimp               REAL,
  ngp_sec_per_km      REAL,
  fatigue_index_pct   REAL,
  cadence_drift_spm   REAL,
  efficiency_factor   REAL,
  phases              TEXT,    -- JSON array of PhaseSegment
  intervals           TEXT,    -- JSON array of DetectedInterval
  computed_at         TEXT NOT NULL,
  stream_analysis_version INTEGER NOT NULL DEFAULT 1
);
```

## References

- Minetti AE et al. (2002). "Energy cost of walking and running at extreme uphill and downhill slopes." *J Appl Physiol* 93:1039-1046
- Banister EW (1991). "Modeling elite athletic performance." *Physiological Testing of the High-Performance Athlete*
- Coggan A. "Normalized Power." TrainingPeaks methodology
- Friel J. *The Cyclist's Training Bible* (HR zone model adapted for running with LT1/LT2)
