---
name: fitness-trend
description: Use when the athlete asks whether they have progressed, what the long-term trend is, how this year compares with last year or with a lab test or race, or why they are above/below an earlier peak — any fitness question spanning more than ~60 days. Not for a single run (workout-analysis) or a 60-day zone check (zone-calibration).
---

# Fitness Trend — Have I Progressed?

A trend read is a measurement, not an impression. The failure mode this skill exists to stop: three different headline numbers from the same data in one conversation (a tool summary said +38%, the chart title said +24.7%, the coach said +11%), each from an ad-hoc cohort, with winter read as "lost fitness" and stroller runs mixed into the baseline. Everything below pins one cohort, one metric, one method, and the confounders that must be checked before a dip is called fitness.

## The one call

`generate_aerobic_chart(months, annotations)` is the method. It builds the cohort, computes the series, draws the chart, and prints the numbers you quote. Do not rebuild the cohort in SQL unless the tool fails; if you do, reproduce its rules exactly (below) and say so.

- `months`: match the question. "Past 1.5 years" → 18. "Since the test in January" → enough to include a window before the test.
- `annotations`: pull from memory BEFORE calling — races (`search_memory` for race names, `get_prediction_history`), illness and injury (health-log, observations), lab tests (test memory files), big blocks or breaks. The chart marks them; the dips then read as events, not mysteries.

## Cohort, metric, method (what the tool does — quote it, don't re-derive it)

- **Cohort**: outdoor runs, average HR inside the Z2 band (LT1 × 0.88 to LT1 from `get_training_zones`), 5–35 km, ≤15 m/km of climb, not tempo/intervals/fartlek/hills/race/progression, no load tags (`stroller`, `weighted-vest`, `sled`, `pack`). Runs whose efficiency sits far from their own ±45-day neighbourhood are set aside as outliers (run-walks, strap dropouts).
- **Metric**: efficiency factor = grade-adjusted speed per heartbeat, in m/min per bpm, from `activity_stream_analysis.efficiency_factor` (stored there as m/s per bpm; the tool converts). Raw speed/HR is only a fallback when a run has no stream analysis, and the summary says how many.
- **Method**: median EF over trailing 90-day windows. The headline is **now (last 90 days) vs first window, vs a year ago, vs the peak window**. Paces are the EF converted to pace at the band's reference HR.
- **Noise floor**: ±2–3% month to month. A difference inside that is "flat", never "slipping" or "gaining".

## Confounders — check every one before calling a dip fitness

| Confounder | Where it shows | What to say |
|---|---|---|
| Cold, snow, ice | monthly `temp` and `sub0` columns; the temperature colour on panel 2 | Pace at the same HR drops on snow and below ~0°C. Winter months are read against their temperature, and the honest comparison is same season last year. |
| Heat | `temp` ≥ ~20°C; the "Heat prior check" line | HR rises for the same pace; summer EF is depressed, not fitness. The tool prints how much a literature prior (+0.2% EF per °C above 10°C, from marathon race data) would move now-vs-peak. Quote that line as an estimate. Only pass `heat_adjusted: true` when the athlete wants the adjusted series, and then every number you quote is called "heat-adjusted". Never apply it to the cold: there is no usable coefficient below ~10°C. |
| Volume | panel 1 | EF follows volume with a lag of a few weeks. A dip after a cut in volume is expected; say what the volume did. |
| Taper and recovery | annotations near races | Fresh legs before a race inflate EF; the weeks after a long race depress it. |
| Illness, injury | memory, annotations | Name it on the chart and in the text. Several weeks of depressed EF after a flu is normal. |
| Load runs | `load_tag` exclusion count | If a stroller run was not tagged, tag it (`tag_activity`) and re-run — do not hand-wave "this month includes stroller Sundays". |
| Strength / other sports | memory | Leg fatigue from lifting or ball sports costs a little speed at the same HR. Mention, don't quantify. |
| Data source change | `raw-EF` notes, device changes in memory | Strava→Garmin or a new strap can shift HR a few bpm. Flag if the change date sits inside the window being compared. |

## Top-end markers (the second half of the answer)

EF is the aerobic base. Add the top end from measured events only:

- Cooper tests, time trials, races: memory (`search_memory`), `best_efforts` / `personal_records`, `get_prediction_history`.
- Lab tests: the test memory file. Compare outdoor to outdoor; never read a 40-minute outdoor run off a 3-minute treadmill stage curve. Distinguish the lab's *measured* values from its *predicted* ones.
- Say when a threshold number is modelled rather than measured, and suggest a retest if the last one is older than ~6 months and a new build is coming.

## Response shape

1. One sentence verdict with the shape: "staircase up", "flat", "up then back to X", "down since Y". Lead with it.
2. The window comparison as the tool printed it (now vs first / year ago / peak), in a small table, paces at the reference HR.
3. What drove each step and dip, each tied to an annotation or a confounder row above.
4. Top-end markers, dated.
5. Caveats: raw-EF fallbacks, untagged load runs, device change, noise floor. One line each, only those that apply.
6. The chart path. The athlete can open it; describe the shape, don't narrate every month.

A "tldr" follow-up repeats the verdict and the now-vs-peak / now-vs-year-ago numbers. Nothing new.

## Anti-patterns

- ❌ First month vs last month, or "best run then vs best run now". Windows only.
- ❌ Quoting a monthly average in the headline. Months are the detail table, not the verdict.
- ❌ Mixing EF units (0.021 vs 1.26). Everything the athlete sees is m/min per bpm or a pace.
- ❌ Calling a winter month a regression without the temperature column.
- ❌ "Includes two stroller Sundays" as a caveat. Tag them, re-run, and the caveat disappears.
- ❌ Reading the lab's predicted Cooper or 10K as a measurement.
- ❌ Quoting heat-adjusted numbers without the label, or inventing a cold correction.
- ❌ Producing a different headline number from one the tool printed, in the same conversation. If the tool's number looks wrong, say why and fix the cohort, don't improvise a fourth one.

**Violating the letter of these rules is violating their spirit.** "The athlete asked a quick question" is not a reason to answer from a month table, and "the chart tool is slow" is not a reason to write a fresh cohort query.
