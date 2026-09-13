---
name: cross-training-analysis
description: Use when a ride, virtual ride, trainer session, walk, hike, ski, rowing or swim lands — any continuous non-run activity — when the athlete asks how hard it was, what the power numbers mean, how it compares to earlier ones, or how it fits a running week
---

# Cross-Training Analysis — Domain Reference

A ride or other continuous non-run session reaches Strava as a heart-rate trace, often a power trace, and a distance that may be real (outdoors) or simulated (trainer, virtual). Every run metric is unavailable or misleading: there is no pace worth quoting, no grade-adjusted pace, no lap structure, and the HR zones calibrated on running sit too high for the bike. What the trace does carry is steady-state load, and on the bike an honest external measure of it, power. That is what `get_cross_training_analysis` measures.

This skill is the domain reference for reading that output. The flow (gather, confirm intent, draft, save) lives in the system prompt's "Cross-training sessions" section and is not restated here.

## Not for

- **Runs**, treadmill included: `get_run_analysis`, the New Run Analysis flow.
- **Intermittent sports** (basketball, tennis, padel, team games): `get_session_analysis` and the intermittent-sport-analysis skill. Those are bouts and breaks, not a continuous load.
- **Lifting**: heart rate reflects rest density, not intensity. The strength-fit-import skill covers it.

## What the tool returns

`get_cross_training_analysis(activity_id)` computes once and caches. Fields worth knowing:

| Field | Meaning | Trap |
|---|---|---|
| `activity.trainer` | Indoor or virtual | Distance, speed and elevation are simulated. Quote duration and load, never "30 km" as if it were a road ride. |
| `activity.strava_power.device_watts` | `true` = a power meter or smart trainer; `false` = Strava's estimate from speed and grade | Estimated watts are a guess from weight and terrain. Treat them as Class C at best; do not compute FTP or decoupling from them, and say so. |
| `hr.avg`, `hr.max`, `hr.max_hr_pct` | Session mean and peak against the athlete's running max | Cycling HR runs roughly 5–10 bpm lower than running at the same effort (less muscle mass, seated, no impact). A ride "in Z2 by running zones" is closer to upper Z2 or Z3 for the bike. Run zones are a ceiling, not a target. |
| `hr.zones`, `hr.trimp` | Run zone bands applied to the trace, and Banister TRIMP | TRIMP is the number to set next to the week's runs; it is the shared currency. Zones are indicative only. |
| `hr.drift_pct` | Second-half mean HR over first-half, minus one | Without power this is the only fatigue signal. It is confounded by heat (a trainer with no fan), a warm-up that starts the first half low, and any intensity change. |
| `power.avg_watts`, `power.normalized_watts`, `power.variability_index` | Mean power, Coggan NP (30 s rolling, fourth-power mean), NP / avg | NP is the physiological cost; avg is the mechanical output. VI near 1.0 is a steady effort; above ~1.1 the ride was surgy (group ride, intervals, stop-start) and NP is the number to quote. |
| `power.work_kj` | Integral of watts over time | Roughly the kcal burned on the bike (gross efficiency ~22–25%, so kJ ≈ kcal). Useful for fuelling talk, not for fitness. |
| `power.coasting_pct` | Share of time at zero watts | Outdoors, 10–20% is normal. On a trainer it should be near zero; if not, the athlete stopped. |
| `power.peaks.*` | Best 5 s, 1 min, 5 min, 20 min mean power | Peaks are only maximal if the athlete tried. The 5-minute peak in an easy hour is what the easy hour held, nothing more. |
| `power.ftp_estimate_watts` | 95% of the 20-minute peak | **A ballpark from this ride only.** It is an FTP estimate only when the 20 minutes were a maximal, evenly paced effort. From an endurance ride it is a floor: "FTP is at least X". Never write "your FTP is" from an easy ride. If the athlete states an FTP, memory holds it and it overrides this. |
| `power.halves`, `power.decoupling_pct` | Pw:Hr (NP per beat) first half vs second, and the drop in percent | Positive = HR rose relative to power. Under ~5% on a steady 45+ minute effort is aerobically coupled. It means nothing on a short ride, a surgy ride, or one with a long warm-up in the first half. Heat and dehydration inflate it. |
| `cadence.avg_rpm`, `cadence.pedalling_pct` | Mean cadence while pedalling, and share of time pedalling | Cadence is a habit, not a fitness number. Note it only when it changes. |
| `previous_sessions[]` | Earlier sessions of the same `sport_type`, newest first, with NP, 20-min peak, decoupling, TRIMP | Sport tagging comes from Strava's `sport_type`; a `VirtualRide` compares with virtual rides only. Compare like with like: trainer to trainer, and similar duration. |

`recompute: true` recomputes from the cached stream, for instance after a zone update.

## Reading rules

**Grade the load in the athlete's running currency first.** Duration, TRIMP, time above LT1. The athlete is a runner; the question is always what the ride did to the week.

**Power is the intensity, HR is the cost.** When both exist, lead with NP for how hard, then HR for what it cost and whether the two agreed (decoupling). When only HR exists, say the read is HR-only and hedge harder.

**A trainer ride is heat.** No airflow means HR drifts upward at constant power without any fatigue. Before calling drift "fatigue", ask about the fan.

**Recovery rides must look like recovery.** An easy spin should sit under LT1 for nearly all of it, VI near 1.0, no 5-minute peak that stands out. If the numbers say otherwise, say so gently: a hard ride the day before a key run is the trap.

**Rides do not bank running volume.** They keep the aerobic system loaded while sparing the tissues. When a ride replaces a run (injury, ankle, bad weather), say what it kept (aerobic load, roughly 1 h bike ≈ 45 min easy run by TRIMP) and what it did not (impact tolerance, running economy, tendon loading).

**Walks and hikes are tissue loading, not aerobic work.** Read them by duration and elevation, and note them in an injury context (return-to-run progression) rather than as training load.

## What the sport trains, and what it does not

- **Aerobic base, without impact.** The primary reason a runner rides. Zone 2 on the bike is the cleanest Z2 there is.
- **Quads and glutes.** A hard ride is a leg-strength stimulus; count it in the week's leg-load budget alongside lifts and hills.
- **Not**: running economy, impact tolerance, calf and Achilles loading, foot strength. A block of cycling does not prepare tendons for a return to running.

## Where it sits in a running week

Easy rides are recovery-day fillers and injury-time substitutes. Hard rides are quality sessions and count against the week's intensity budget. A ride the evening before a long run costs freshness in the quads; a ride the morning after a race is a recovery tool.

## Memory

After the first analysed ride in a season, record with `write_memory`: the setup (trainer model, power source: meter, smart trainer or estimate), whether the athlete has a stated FTP, and why they are riding (recovery, injury, commute, preference). After later rides, record only what changed. The tool holds the numbers; memory holds the context the numbers cannot.

## Not built

No FTP-based zones, IF or TSS: they need a confirmed FTP, which the athlete states or tests. No terrain segmentation for outdoor rides. No swim-specific metrics (stroke, SWOLF). History is analysed from cached streams only; an older ride's stream is fetched the first time it is asked about. There is no Strava writeback for cross-training sessions.
