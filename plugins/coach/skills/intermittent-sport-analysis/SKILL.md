---
name: intermittent-sport-analysis
description: Use when a heart-rate-only session lands — basketball, tennis, padel, badminton, squash, football, floorball, hockey or any intermittent sport Strava records without distance — when the athlete asks how their body handled such a session, what it trains, how it compares to earlier ones, or how it fits a running week
---

# Intermittent Sport Analysis — Domain Reference

A court, racket or team-sport session reaches Strava as a heart-rate trace and nothing else: no distance, no pace, no laps that mean anything. Every run metric is therefore unavailable, and every run habit (average pace, drift, splits, zone honesty against an easy prescription) is wrong here. What the trace does carry is the intermittent shape of the effort, and that is what `get_session_analysis` measures.

This skill is the domain reference for reading that output. The flow (gather, confirm format, draft, save) lives in the system prompt's "Heart-rate-only sessions" section and is not restated here.

## Not for

- **Runs**: `get_run_analysis`, the New Run Analysis flow.
- **Lifting**: heart rate reflects rest density, not intensity. The strength-fit-import skill covers it.
- **Continuous sports with distance** (rides, ski, rowing, swimming): they have pace or power; the bout model does not apply.

## What the tool returns

`get_session_analysis(activity_id)` computes once and caches. Fields worth knowing:

| Field | Meaning | Trap |
|---|---|---|
| `max_hr`, `max_hr_pct` | Session peak and % of the athlete's max | This is the effort headline, never `avg_hr`. A 60-minute basketball session and an easy run can share an average and differ by 40 bpm at the peak. |
| `time_above_90pct_s`, `excursions_above_90pct` | Seconds at or above 90% of max, and how many separate visits | The honest measure of how much hard work the session held. |
| `time_above_lt2_s` | Seconds above the lactate-threshold HR | Compare with what a threshold run would give. |
| `play_start_s`, `play_avg_hr` | Where warm-up ended and the mean HR of the play period | `play_avg_hr` is the number to quote for "how hard was the playing"; the Strava average folds in the warm-up. |
| `bouts[]` | Detected bouts of play: `start_s`, `end_s`, `peak_hr`, `mean_hr`, `is_warmup` | Detection is a heuristic on the trace alone. Short changeovers that never let HR fall far stay inside one bout; a proper sit-down splits two. `is_warmup` marks low bouts before the first full-intensity one (drills, shooting). |
| `breaks[]` | Gaps between bouts: `floor_hr`, `drop_bpm`, `max_drop_60s_bpm`, `is_warmup` | A break is the athlete sitting or standing, not recovery inside play. Do not describe a sit-down floor as "recovering while playing". |
| `halves`, `peak_drift_bpm`, `floor_drift_bpm` | First-half vs second-half mean peak and mean floor, warm-up excluded | Negative peak drift means the peaks faded. Positive floor drift means breaks stopped clearing as deep. Flat both ways is the fitness signature. |
| `thresholds` | The enter and exit HR used for detection, `adaptive` or `explicit` | Adaptive thresholds come from the session's own HR distribution, so tennis at lower intensity still segments. |
| `hr_zones`, `trimp` | Run zone bands applied to the trace, and Banister TRIMP | Zone bands mean less here than in a run; TRIMP is useful as a load number next to the week's runs. |
| `previous_sessions[]` | Earlier sessions of the same `sport_type`, newest first | Sport tagging comes from Strava's `sport_type`; basketball compares with basketball only. |

Re-cut with `options` when the bouts do not match the format the athlete describes. `min_break_s` up (60 to 90) merges short changeovers; explicit `bout_enter_bpm` / `bout_exit_bpm` pin the thresholds. The re-cut is stored.

## Reading rules

**Grade the session on its peak and its time above 90%, never on the average.** Intermittent play drags almost everyone to about 90% of max in the bouts. That is the sport, not the athlete.

**The peaks are set by the sport; the engine shows between them.** Studies of 5v5 basketball put mean live-play HR at roughly 85 to 91% of max regardless of player level. So a peak of 95% of max says the athlete played hard. It does not say anything about fitness. Fitness shows in three places:

1. **Floors.** How far HR falls in a real break, and whether the floor holds across the session (`floor_drift_bpm` near zero) or climbs.
2. **Repeatability.** Whether the last bouts reach the same peaks as the first (`peak_drift_bpm` near zero). A cardiovascular limiter shows as peaks falling away in the back half because the legs stop producing the output that drives HR there.
3. **The next day.** Whether the athlete runs normally the day after a session at 90% of max. That is the payoff of an aerobic base and it is not inside the hour at all.

**Do not read sit-downs as in-play recovery.** A 50 to 60 bpm drop over a two-minute bench sit is normal. The finding is whether it happens to the same floor every time.

**Separate the engine from the tissue.** After a novel or returning sport the session feels brutal for tissue reasons: cutting, decelerating and landing that a runner's tendons and quads have not done. If the peaks and floors held, the heart was not the limiter and the read should say so plainly. Soreness the next day is a tissue story, not a fitness story.

**Warm-up is not play.** Use `play_start_s` and `play_avg_hr`; the session average understates the playing part badly when the first 15 to 20 minutes are drills.

**Format is Class C.** Game length, rotation, whether breaks are sit-downs or changeovers, who the athlete played against, how involved they were: none of it is in the trace. The first time a sport appears in a season, ask once and record it. After that, read from memory.

## Cross-session comparison

`previous_sessions` makes progression one call. Compare like with like:

- **More time above 90% with the same floors** means more involvement or harder games, not worse fitness. Skill and confidence returning after a layoff usually push this number up.
- **Floors drifting lower across weeks at similar peaks** is the economy and fitness signal: the same play costs less, or clears faster.
- **Peak drift moving from negative toward zero** across sessions means the back half stopped fading.
- **TRIMP next to the week's runs** places the session in the load picture. A court session often out-loads every run of the week except the long run.

Say what changed and what did not. Two or three numbers, not a table of every field.

## What the sport trains, and what it does not

Evidence summary for a distance runner adding one or two court sessions a week (sources in the knowledge base topic "intermittent sport heart rate demands and training value for a distance runner"):

- **Aerobic base: small.** One hour a week against a real running volume is a minor aerobic stimulus. Do not present basketball or tennis as a substitute for easy volume.
- **High-intensity intermittent dose: real.** Fifteen to twenty minutes above 90% of max in a session is a genuine stimulus that most easy-heavy running weeks do not contain. It lands at the top of the intensity range, above the threshold band, so it does not replace threshold work; it complements it.
- **Bone and multidirectional loading: the runner-specific payoff.** Running is poorly osteogenic compared with ball sports; multidirectional loading history is associated with better bone geometry and lower bone stress injury risk in runners. This matters most for athletes building toward high weekly volume.
- **Tissue tolerance for cutting, deceleration and landing**, and **exposure to near-maximal velocities**, which steady running never provides.
- **Returning players carry a specific risk.** Skill learned young comes back in weeks; tendon and bone capacity for cutting and landing takes roughly eight to ten weeks. The athlete can produce the hard cut long before the tissue is ready for it. Name the gap without prescribing restrictions the athlete has not asked for.

## Sport profiles

Typical values from match-play studies, for calibrating expectations, never for grading the athlete:

- **Basketball (5v5).** Mean live-play HR about 85 to 91% of max; 65 to 75% of live time above 85% of max; peaks at or near max are ordinary. Live movement roughly 5 to 6 km per 40 live minutes at jogging speed, so no volume is banked. Recreational formats are usually short games with sit-down rotations, which is why bouts and breaks segment cleanly.
- **Tennis and padel.** Mean HR 60 to 80% of max with rallies spiking above 95%. Points last seconds with work-to-rest around 1:2 to 1:5. Low time above 90% is normal and is not a low effort. Bouts correspond to games or sets; breaks are changeovers. Padel doubles sits a little lower than singles tennis.
- **Badminton and squash.** The highest of the racket sports; elite badminton means near 180 bpm, squash is close to continuous. Expect long bouts, shallow breaks and a high play average.
- **Football, floorball, hockey, handball.** Invasion sports where bouts are shifts or halves. Floorball and hockey rotate in short shifts, so expect many bouts with deep, short breaks; football produces one or two long bouts with a half-time floor.

## Where it sits in a running week

- It is a hard session. Count it as one of the week's quality slots, and read the surrounding days accordingly.
- It banks no running volume and is not a threshold substitute.
- When it collides with a plan, the plan moves around a fixed social fixture more easily than the fixture moves; say what the collision costs rather than arguing the fixture.

## Memory

After the first session of a sport in a season, record with `write_memory`: the format (game length, rotation, break type), the weekday and slot, what the athlete said it felt like, and any tissue complaints. After later sessions, record only what changed. The tool holds the numbers; memory holds the context the numbers cannot.

## Not built

No movement, distance or acceleration data exists for these sessions; do not infer court distance. History is not backfilled at sync; the tool fetches an older session's stream on demand the first time it is asked about. There is no Strava writeback for sessions.
