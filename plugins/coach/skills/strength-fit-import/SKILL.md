---
name: strength-fit-import
description: Use when a strength session needs set-level detail — the athlete asks about a lift, mentions doing one, asks you to fetch or import a gym session, or you are analysing a WeightTraining activity and need the exercises, sets, reps, weights or true rest intervals that Strava does not expose
---

# Strength FIT Import

Strava's API gives you duration, calories and heart rate for a strength session and **nothing else** — no exercises, sets, reps, weights, tonnage or rest intervals. Its app displays them because it parses the uploaded FIT file internally; that data has never been in the public v3 API.

The original Garmin FIT file **does** carry all of it. This skill fetches that file.

## When This Skill Applies

Load it when set-level detail would change your read, and you don't already have the numbers from the athlete:

- Analysing a `WeightTraining` / `Workout` / `Crossfit` activity
- The athlete asks what they lifted, or how a lift compares to a previous one
- You need real rest intervals (e.g. checking Tactical Barbell's minimum-rest rule)
- Progression questions: "am I adding load?", "how did squat move this month?"

**Do not** load it just because a lift exists in the plan or in compliance output. If the athlete already told you the numbers this turn, or you only need the fact that a session happened, you don't need the file.

## The Two Routes — offer both, do not silently pick one

Fetching requires the athlete's Garmin credentials, so it is **not** something you can do unprompted on first use. Always give them the choice:

1. **They paste the numbers.** Fastest, and often enough: exercises + sets × reps × weight, plus anything notable (form, RPE, failures, pain). Prefer this for a single session.
2. **You fetch the FIT.** Better when they want it automated, when several sessions are involved, or when true rest intervals matter — those are hard to recall accurately but exact in the file.

## Fetching

Run from the project root. There is no setup step — every command signs in on demand:

```bash
# By start time — the reliable route. Use the Strava activity's start_date.
.venv-garmin/bin/python scripts/garmin_fit.py fetch --at 2026-08-03T18:07:54Z

# Or by Garmin activity id, if you already know it
.venv-garmin/bin/python scripts/garmin_fit.py fetch 23840025442

# To see what is there
.venv-garmin/bin/python scripts/garmin_fit.py list --days 14 --strength
```

Files land in `data/fit/`.

### When it says it can't sign in

Sign-in prompts only when attached to a terminal. **You are not**, so if no valid tokens are cached the command exits immediately with instructions — it will not hang. That output is the signal to hand the step to the athlete:

> Sign-in is needed once. Run this in your terminal and it'll ask for your password and an MFA code:
> `.venv-garmin/bin/python scripts/garmin_fit.py login`
> After that I can fetch on my own.

They can run it inline by prefixing with `!`. Tokens cache in `.garmin-tokens/` and every later fetch of yours works unattended. The same message appears when tokens expire — same fix.

If the venv is missing entirely, that setup is theirs to run too:

```bash
python3 -m venv .venv-garmin
.venv-garmin/bin/pip install -r scripts/requirements-garmin.txt
```

Do not treat a sign-in message as "the data is unavailable" — it means one interactive step is outstanding. Say which, and offer the paste-the-numbers route meanwhile.

### Why `--at` rather than an id

Our database keys on **Strava** activity ids. Garmin uses its own, and the two share no field — Strava's `external_id` is a push id, not a Garmin activity id. But both platforms record the same start instant, so start time is an exact join, not a heuristic. Take `start_date` from the Strava activity and pass it to `--at`.

The script refuses to guess: no match within 2 minutes is an error, and multiple matches is an error listing the candidates. If it refuses, run `list` and resolve it explicitly rather than forcing a guess.

## Reading the FIT

Parse with the `fit-file-parser` npm package (already proven against this athlete's Enduro 3 — no Python or Garmin SDK needed). Sets are at `data.sets` / `data.messages.set`.

Traps, all confirmed against a real file:

- **`set.duration` is not time-under-tension.** It is the lap-button interval and includes setup, plate changes and forgetting to press the button. One real set read 8:10 for 6 reps. Never present it as work time.
- **`weight: 0` is a written value, not a missing one.** Rest sets have `weight: null`; zero means an empty bar or bodyweight. Use `!= null`, never truthiness — `if (set.weight)` silently drops bodyweight sets.
- **Timed vs open rest.** A rest whose `workout_step` has `duration_type: "time"` was ended by the watch's timer, not the athlete. Reading "they rested exactly 60s, disciplined" would be wrong. Only `duration_type: "open"` rests reflect athlete behaviour. Check `wkt_step_index` before making any rest-discipline claim.
- **Warm-ups are not flagged on the set.** Every set is `set_type: "active"`; warm-up classification lives in the `split` stream. Naive tonnage includes warm-up sets.
- **Pull-up weight is *added* load.** True tonnage needs bodyweight, which the file provides at `user_profile.weight`.
- **`category`/`category_subtype` are 3-element arrays** with identical elements — take `[0]`.
- **Exercise names:** join `set.(category, category_subtype)` to the file's own `exercise_title` messages for Garmin's display strings. No mapping table needed.
- **Strings are 0xFF-padded**, not NUL-terminated — strip at the first replacement character.
- **Garmin's anaerobic training effect reads ~0 for lifting.** Its cardio model sees nothing. Compute load from tonnage; do not quote TE as evidence the session was easy.

## After Importing

Record what you learned with `write_memory` — exercises, working weights, rep ranges, and the date. Nothing else in the system persists set-level data yet, so without that write the next session starts blind again and progression questions stay unanswerable.

## What Is Not Built

There is **no automatic import**. Nothing watches `data/fit/`, no sync step pulls Garmin, and the database has no strength-set tables. Fetching and reading are manual, per session. Say so plainly rather than implying the app ingests these on its own.
