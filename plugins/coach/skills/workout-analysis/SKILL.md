---
name: workout-analysis
description: Use when analyzing a completed run or a batch of just-synced runs — assessing execution against the plan, effort, pacing, HR, drift, fade, and signals, and writing the private coaching analysis
---

# Workout Analysis — Domain Reference

This skill is reference knowledge for the coaching read: what the metrics mean, which evidence supports which claims, and the domain traps that produce confidently wrong analyses. The **flow** (gather → triage → draft → review → save → post), the **depth and chat-output policy**, the **claim classes (A/B/C)**, and the **calibration principle** live in the system prompt's "New Run Analysis" section — they are not restated here, and nothing in this file overrides them.

## Two Artifacts, Not One

The **coaching analysis** (`detailed_analysis`) is the private, thorough record saved via `save_run_analysis` — plan-aware, load-aware, with derived metrics, hypotheses, and implications. The **Strava description** is a separate artifact: tight, public, what-happened-only, produced later by the strava-writeback skill only when the athlete asks to push. Never collapse one into the other.

## Dimension Menu

Layer 2 of the saved analysis draws from these dimensions. Include one only when it carries a finding (depth policy is in the system prompt):

- **Plan-vs-actual** — type AND size (see Plan Comparison below)
- **Training-load significance** — TRIMP, 7d volume, percentile vs 30 days, position in the week
- **Phase / lap / structure breakdown** — when the run had phases, climbs, intervals, or pace shifts; don't average over a story
- **Derived metrics that disambiguate** — efficiency factor (NGP / avg HR) when comparing runs at similar HR; pace-CV across laps (high CV ≠ fade if it tracks elevation); GAP vs raw pace when terrain shaped the effort; `hr_trend.pattern`; `cardiac_drift_pct` with confound check; `movement.split_driver` on any run with walk breaks
- **Cross-run comparison** — triggers below
- **Causal hypotheses** — hedging proportional to confound risk
- **Mistakes / learnings** — only when data + context support them; don't invent lessons
- **What-to-do-next** — when the run signals something the plan should respond to

A recommendation must not contradict a conclusion reached elsewhere in the same read: if a zone was judged stale, don't prescribe running to it; if elevated HR was attributed to a confound, don't coach pace discipline off that same HR.

## Calibration Reference — What Shifts the Expected Numbers

The system prompt's rule is that context calibrates the *expectation*, never the verdict. These are the adjustments worth knowing:

- **Technical trail**: matched-effort comparisons put HR ~+10%, energy cost ~+20-25%, and RPE up ~50% vs even ground (stabiliser recruitment, higher leg stiffness). A genuinely easy effort on technical terrain reads well above the road easy band — apply the ~10% to the athlete's easy HR band before judging effort.
- **GAP under-corrects on trail**: grade-adjustment curves come from smooth-treadmill data with no term for roots, rock, mud, or braking, and grade smoothing erases short steep pitches. Treat trail GAP as a floor on true effort, and treat pace on technical terrain as close to uninformative.
- **GAP is blind to pushed/carried load (stroller, weighted vest, sled)**: every grade-adjustment model corrects for the *runner's* body mass climbing, so on a loaded run it under-corrects, and the error scales with both the added mass and the climbing. A 40kg rig on a 77kg runner means GAP did its sums on 77 of 117kg. Size the miss two ways and take the range: direct energetics (`added_mass × g × gross_gain / 0.25`, against a base near `4 J/kg/m × body_mass`), and scaling GAP's own terrain correction by `added_mass / body_mass`. GAP also over-credits descending, because a loaded rig is braked rather than ridden. Documented mechanism: the stroller penalty on a 10% grade runs ~3× the flat-ground penalty (Frontiers Physiol 2020). **Never read a loaded run's back-half GAP decay as fatigue without first checking where the climbing sat** — an out-and-back that returns uphill produces exactly the signature of a fade that never happened.
- **Per-km GAP is unusable when the altitude sources disagree**: before quoting individual lap GAP values, compare the raw altitude stream's summed gain against the smoothed device figure and Strava's. A large spread (e.g. +318m raw vs 92m smoothed vs 143m Strava on rolling ground) means per-km grade adjustment is noise, and different methods will disagree by up to ~20 s/km on the same kilometre. Only aggregate half-to-half comparisons average it out. A "step at km N that held" read off a single lap series is the failure mode.
- **Heat/humidity**: elevates HR and drift at a given pace; check `weather` before attributing drift to fitness or fatigue.
- **Still-air indoor / treadmill**: cooling scales with airspeed, so a badly ventilated room costs extra beats at a given speed. Treadmill distance and pace are also soft — the watch's integrated stream and Strava's stored distance routinely differ ~5%, and a wrist accelerometer damps real belt-speed changes, which *understates* computed decoupling. Keep treadmill runs out of the outdoor efficiency-factor series.
- **Stale zones**: `get_training_zones` is the only source of truth for current paces — never a plan pace string or an old lab test. If training-data pace consistently beats the stored band with stable Z2 HR and low drift, the zone is stale: name it and consider a fitness-drift update rather than grading against the stale band.
- **HR over pace for effort**: on easy runs HR is the ground truth; pace inherits terrain, wind, and surface noise.

Calibration explains a number; it does not re-label a session. If HR sat above even the calibrated band, or the load (TRIMP, percentile) far exceeded what the prescription implied, the session was hard — the read says so first and quantifies the tax second.

## Assessment Reference by Session Type

### Easy runs
- Pace within the current easy range from `get_training_zones` (pace.easy); HR in Zone 1-2 (between LT1 × 0.88 and LT1).
- Fast-looking pace + stable Z2 HR + drift < 5% → the zones are likely stale, not the athlete undisciplined. Hard-reading HR beyond the calibrated band → the run was hard regardless of its label. Report whichever direction the calibrated gap points.

### Long runs
- First half comfortable; pace within 30-60s/km of marathon pace is fine for experienced runners; negative split ideal.
- Cardiac drift >10% at same pace indicates accumulating fatigue.
- Runs over 90 minutes should include fueling.

### Run-walk sessions (trail/ultra, or any deliberate walk breaks)

Raw avg pace, `split_type`, and `fatigue_index_pct` fold walking into "pace" — on a run with walk breaks, a back-half slowdown looks like a running fade when the running held and the athlete just walked more. The `movement` block disambiguates deterministically; use it, don't eyeball per-km tables.

- **Lead with `movement.split_driver`:** `"walking"` → running held, back half slower from more walking (the expected shape of a walk-the-climbs session, not a fade). `"mixed"` → running also faded materially (run-only fatigue ≥5%); name both. `"running"` → the running itself slowed. `"none"` → nothing slowed once grade is accounted for; there is no fade to narrate.
- **Walking the climbs is execution, not a finding.** Above ~+15% grade walking is metabolically cheaper than running (Minetti), and it spares the quads for descents. When the plan says walk the climbs, walk time in the up-grade bands is the prescription being followed.
- **Walk terrain comes from `walk_grade_band_min` (+ `_by_half`), never eyeballing.** Bands are signed: descent < -1%, flat ±1%, gentle_up 1-3%, moderate_up 3-6%, steep_up > 6%. 1-3% is uphill, not flat. Walking spreading from climbs to flats and especially to descents late in a long event is a fuel/fatigue fingerprint, not a terrain story.
- **HR on run-walk: per-state fields, not the blend.** When `walk_pct` ≥ ~15-20%, whole-run `avg_heartrate` is a compositional artifact. Read `movement.run_avg_hr`, `movement.walk_avg_hr`, `movement.run_avg_hr_by_half`. Never infer "engine wasn't the limiter" from the blended average.
- **`pauses` are watch-stopped time, not movement.** Walk and pause locations come from `movement.walks` / `movement.pauses` (`at_km`) — never guessed from lap pace.
- **Reconcile with the athlete's own account of their walks** — confirm the tagged segments match it rather than contradicting them.

### Terrain shape — before narrating any split, fade, or "held it well"

Grade contaminates the pace curve on every run that isn't a track session. A net-flat run can open downhill and close uphill, and the raw per-km table will show a textbook fade that never happened.

- Whole-run `elevation.gain_m` / `hill_category` are totals — they never say *where* the climbing was. Do not conclude "terrain wasn't a factor" from a total.
- Read the shape from lap `net_elevation_m` / `avg_grade_pct` **before** the pace column — a pace curve you've already explained is hard to unexplain.
- Compare lap `grade_adjusted_pace_sec_per_km`, not raw lap pace, whenever `net_elevation_m` moves across the run. Flat GAP + slowing raw pace = held effort, hill took the pace — the opposite of a fade.
- HR flat while pace slows on a climb is strength, not fatigue. The fade signature is decoupling: HR climbing to hold a slowing pace, or GAP itself decaying.
- Every fade metric is already grade-adjusted (`split_type`, `fatigue_index_pct`, `movement.run_only_*`). If a metric says "even" and the raw table looks like a fade, the metric is right and the table reading is wrong.

### Races / ultras (RACE DAY in the plan, ≥4h elapsed, or first-of-kind distance)

Most single-number summaries assume a 40-120min continuous road run; on a multi-hour run-walk event they become compositional artifacts. Switch modes:

- **Debrief the athlete BEFORE drafting** (the explicit exception to draft-and-hedge — the triage step in the system prompt governs this). The athlete's account of fueling, GI, limiter sequence, and stop strategy is primary data the streams cannot contain.
- **Decompose elapsed / moving / stopped time first.** Stopped time is strategy to be understood, not inefficiency to be fixed — ask or hedge before coaching "reclaim the stopped time".
- **Never read whole-run avg HR as effort** (see run-walk above). "Avg HR low → engine wasn't the limiter" is the canonical wrong read.
- **Cardiac drift is directional-only** beyond ~4-6h or in heat: it blends fitness with core temperature, dehydration, and glycogen state.
- **Align the conditions timeline with the athlete's position** (`weather.hourly`): heat damage is often seeded mid-race and paid hours later. Never quote a window-average temp as "the temperature".
- **Frame limiters as a chain** (heat → gut → fueling → energy low → forced walking → legs late), sequenced by when they appeared — not a single crowned cause.
- **Goals: reconcile against the stated basis** (effort- or daylight-based targets shift with actual conditions). **Novel distance = calibration, not verdict.**

### Tempo / threshold
- Sustainable for ~60 minutes in a race; HR Zone 3-4; "comfortably hard".
- Consistent splits (<5s/km variation) = good execution.

### Intervals
- 400-800m at ~5K pace or slightly faster; 1000-1600m at 5K-10K pace.
- Recovery adequate (jog, not walk-to-a-stop); consistency across repeats beats one fast split; positive splits across repeats suggest starting too fast.

## Load and Signal Reference

- **ATL** (7d): sum of distance × intensity factor (easy 1.0, tempo 1.5, intervals 2.0, race 2.5). **CTL** (28d rolling): fitness trend. **TSB** = CTL − ATL: positive = fresh, negative = building, < −20 = overtraining risk.
- **80/20**: ~80% of running easy (Z1-2), ~20% moderate+. More than ~25% moderate+hard = too much intensity.
- **Cardiac drift**: first-15min vs last-15min HR at same pace. >10% = dehydration, heat, or insufficient fitness; >15% = significant concern.
- **HR trend shape** — never characterize HR by endpoints. Use `hr_trend`: `step_then_plateau` = normal ramp-and-settle, NOT drift ("HR settled at X after initial ramp-up"); `linear_drift` = actual cardiac drift, worth flagging; `stable` = strong aerobic signal. If `cardiac_drift_pct` < 3%, a claim of "concerning HR rise" is almost certainly wrong.
- **Cadence**: 170-185 spm optimal for most; <160 may indicate overstriding; rises naturally with speed.
- **Pace variability on easy runs**: high variability on flat terrain = inconsistent effort; suggest running by feel/HR.
- **Elevation impact**: ~5-8s/km per 100m gain is normal.
- **Red flags**: HR significantly higher than usual at same pace; pace dropping on easy runs; inability to hit interval targets from 2 weeks ago; rising RPE at same objective effort; missed or cut-short workouts.

## Evidence Gate — Cite the Metric Before the Claim

Every characterization must point to the field that proves it. If you can't name the metric, soften to a hypothesis or drop it.

| Claim | Required evidence | NOT sufficient |
|---|---|---|
| "Faded in the back half" | `movement.split_driver` = `running` or `mixed` (never `none`) AND `run_only_fatigue_index_pct` ≥ 5 | A slower back-half average pace; raw lap paces trending slower |
| "The pace change was terrain, not fatigue" | lap `avg_grade_pct` / `net_elevation_m` shape AND lap `grade_adjusted_pace_sec_per_km` holding steady | Whole-run `elevation.gain_m` or `hill_category` |
| "Cardiac drift / ran out of gas" | `cardiac_drift_pct` elevated AND confounds clear | HR higher at the end |
| "HR climbed through the run" | `hr_trend.pattern` = `linear_drift` | First-vs-last HR delta |
| "Too fast for easy" | pace outside current `get_training_zones` AND HR above Z2 | A stored or plan pace string |
| "New PR / best effort" | `best_efforts` or the PR record confirms | A fast-looking split |
| "Fitness is up" | the drift signal (`get_fitness_drift`) | One good run |
| "Engine/HR wasn't the limiter" (run-walk) | `movement.run_avg_hr` + drift with confounds clear | The walking-deflated whole-run `avg_heartrate` |
| "It was N°C" on a multi-hour run | `weather.hourly` / `temp_min_c`-`temp_max_c` range | `temp_avg_c` quoted as a single temperature |
| "Prescribed prep (sauna/strength/gut) paid off" | Athlete confirmed doing it (session, memory, prior analysis) | The plan prescribing it |
| "The course climbed Xm" | `elevation.gain_m` with `source` noted (see elevation policy) | Either source quoted as sole truth when `discrepancy_note` fires |

**Prep-adherence — plan ≠ execution.** The plan says what was *scheduled*; only run data and athlete statements say what was *done*, and non-run work (sauna, strength, gut training, mobility) leaves no Strava trace. "The heat prep paid off" is valid only if the athlete confirmed doing the work — otherwise it credits training that may have been skipped. When adherence is unknown and load-bearing: ask in a race debrief, or hedge both branches. Same rule inverted: don't scold non-adherence you haven't verified.

## Pull Domain Knowledge Before Drafting

The knowledge base (`research` tool) accumulates science syntheses so analyses don't run on generic intuition. **Mandatory** before drafting when the run is a race, ultra/trail event, or first-of-kind distance; when conditions are outside the athlete's routine (extreme heat/cold, altitude); or when the read hinges on physiology you'd otherwise state from memory. Otherwise optional but cheap.

Call `research` with `listTopics: true`, pull matching topics with `research(topic)`. A stale-cache response still includes the previous research — use it, don't block on a refresh. If a load-bearing topic is missing, research it (WebSearch + `save_research`) *before* drafting. Ground causal claims in the research and cite the mechanism in a clause — "reduced gut blood flow in heat slows carb absorption" — not a paragraph per citation; the fuller mechanism walk-through belongs in the saved analysis only when it changes what the athlete should do.

## Cross-Run Comparison

A capability to reach for when it adds coaching value, not a default step.

**Reach for it when:** daily double / same-day pair; same workout type recently repeated (progression check); athlete reports a perceived difference ("felt stronger", "felt heavier"); outlier vs the athlete's recent baseline; plan-prescribed comparison (B2B long runs, dress rehearsal vs race goal).

**Don't force it when:** the run stands alone; the candidate comparison is weeks old under shifted conditions/fitness; it would restate the per-run reads without new insight.

**How:** pull comparison runs via `query_activities` or `get_run_analysis`; build a side-by-side (distance, pace, GAP, avg HR, drift, zone split, elevation, efficiency factor, pace-CV, weather); identify where numbers and perception diverge — "athlete felt fade, EF says stronger" is one of the most coaching-valuable reads; say what it means for training.

**Elevation — source-of-truth policy:** the `elevation` block carries provenance: `source: "device-stream"` (consistent algorithm across runs) or `"strava-api"` (per-upload DEM smoothing of varying intensity — the same route has reported 275m vs 376m). Prefer the device-stream value. When `discrepancy_note` fires (>20% gap), use the stream value and *name the discrepancy* — never present the API figure as sole truth. Same-route elevation differences >20% across uploads are a smoothing artifact, not terrain. Altimeters also drift ~5-10% across multi-month gaps; small differences months apart are noise.

## Plan Comparison

Establish what the run was *supposed* to be before assessing effort quality:

1. **Check plan context.** The startup prompt pairs each new run with its planned session; otherwise call `get_plan_compliance` (omit `week_number` for the current week).
2. **Lead the plan-vs-actual dimension with the plan reference** ("You had **Tempo** scheduled — 12km: 2km WU → 30min @ threshold → 2km CD").
3. **Assess against the plan, not generic templates** — session type matched? Intensity target hit? Structure executed? Easy genuinely easy? **And size**: compare actual distance/duration against the plan's figure or the athlete's norm for that session type. A midweek easy run at long-run size, a 30min shakeout that runs an hour, a long run cut in half — each is a finding invisible to a type-only match.
4. **Note deviations explicitly** — distance/pace missed by >10%, a different type than planned, a run on a planned rest day.
5. **No plan match** → unplanned; note briefly, analyze on its own merits.

### Dates, weekdays, and run counts — never eyeball these

Every weekday name, "run N of the week" count, and "N days/weeks since/until" claim comes from data, never from plan-row position or your own mental calendar — the one that "looks obviously right" is exactly the one that ships a hallucinated analysis.

- **Weekdays**: `get_plan_compliance` returns `planned.weekday` / `actual.weekday` — use verbatim. Row N of a plan is NOT day N of the week. For any other date, call `date_calc`.
- **Temporal distances**: within the compliance week, difference of `planned.daysFromToday`; everything else via `date_calc` (`days_difference`/`weeks_difference`). In a batch, recompute per run — the count correct for Wednesday's run is off-by-one for Thursday's.
- **"Run N of the week"**: from `completedRunIndex` (1-based, true date order) and `summary.completed`. Never count plan rows — a skipped session is still a row.
- **Rest vs run day**: from `actual`/`status`. `actual: null` on a past date is `missed`, not a completed run; a day with no row and no activity is a rest day — never invent a run for it.

### Annotating completion in the plan

Annotate exactly once per run, on the FIRST turn after posting where the athlete (1) acknowledges, (2) asks for a Strava push (annotate before invoking strava-writeback), or (3) pivots to an unrelated topic. If they keep iterating on the analysis itself, don't annotate yet. Never annotate in the same turn as the initial post, and never re-annotate on later revisions.

Mechanics: `manage_plan(action: "update")`, adding a brief outcome to the session cell in the existing convention — `✅ 12.1km @ 5:08/km, hit tempo target`, or with the key deviation: `✅ 8.2km tempo done at 4:55/km — 30% short on distance`. Preserve every other row exactly.

## Clarifying Questions

The triage policy — when a question is allowed to block drafting (unscheduled run, firing confounds, race debrief) and when it is not — lives in the system prompt. This is the how:

- **One question per run, plain prose**, like a coach who reviewed the file and wants to understand what they're seeing. Good: "The drift suggests something was working against you in the second half — were you well-hydrated going in, or was it one of those days?" Bad: a numbered interview.
- **The question is the last thing in the response — no review, no save, no tools after it.** Free text doesn't pause execution; the only way to wait is to stop. The reply arrives as a new turn; revise + review + save happen there. If you wouldn't stop and wait for the answer, you aren't asking — you're speculating in prose.
- **Class C gaps get hedged, not asked about.** Write both branches ("if the cold had cleared, X; if you pushed through run-down, flag it — the physiology shows no cost either way") and keep the batch moving.
- **In a batch**: at most 1-2 questions total, bundled into one turn, for the most coaching-consequential ambiguity only.
- **Using the answer**: revise where it changes the read (a sentence of correction, not a rewrite), then continue the normal review → save → post flow. If the answer reveals a recurring pattern, save it to memory once the conversation settles.

## Multi-Run Batching

Runs that sync together are a connected batch, not independent silos:

1. **Gather everything first** (get_run_analysis + zones + plan compliance for every run) before drafting any read.
2. **Draft chronologically (oldest first)**, each read aware of its siblings — prior load and recovery state behind it, what the day was setting up ahead of it. Reference siblings by verified weekday/date.
3. **Give the reviewer sibling context**: when a draft references a sibling run, include that sibling's key data (date, weekday, distance, pace, HR, type) in the reviewer dispatch so the reference verifies instead of being flagged as unsupported.
4. **Batch synthesis** after the per-run reads when the runs form a related set (back-to-back days, daily double, weekend block): cumulative load and the through-line. Skip only when the runs are genuinely unrelated, and say so briefly.
5. **Scope**: the synced runs plus the normal recent context the tools already surface — not a season review.

## Feedback Tone

Lead with the positive; be specific (actual paces, distances, dates); contextualize against the athlete's own baseline, not abstract standards; one key takeaway, not ten observations; make change actionable (what and how); check memory for whether the pattern has appeared before.
