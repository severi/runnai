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

## The Two Routes

1. **You fetch the FIT** — the default. It is a tool call, and once signed in it needs nothing from the athlete at all. It is also the only route that gives true rest intervals and exact loads, which are hard to recall accurately.
2. **They paste the numbers** — still worth offering alongside, since it is instant and they may prefer it: exercises + sets × reps × weight, plus anything notable (form, RPE, failures, pain).

Fetching is no longer something to ask permission for. The only step that ever needs the athlete is a one-time MFA code (and, before that, credentials in `.env`) — after which every later fetch is silent.

## Fetching

Use the tools — there is nothing for the athlete to run:

- `garmin_fetch_fit(start_time: "<the Strava activity's start_date>")` — downloads into `data/fit/`.
- `garmin_auth()` if that says you are not signed in. Credentials come from `.env`; you never see a password.
- On **needs_mfa**: ask for the 6-digit code and wait, then `garmin_auth(mfa_code: "...")` and continue. Nothing can proceed without it and it expires in ~30s, so ask on its own and immediately.
- On **needs_credentials**: the athlete adds `GARMIN_EMAIL` / `GARMIN_PASSWORD` to `.env`. Never invite a password into the chat — it would be stored in the transcript.

`start_time` is the reliable route: our database keys on Strava ids, Garmin uses its own, and the two share no field — but both record the same start instant, so it is an exact join. The fetch refuses to guess (no match within 2 minutes errors; multiple matches lists candidates).

The equivalent CLI, if the athlete ever wants it directly:

```bash
.venv-garmin/bin/python scripts/garmin_fit.py fetch --at 2026-08-03T18:07:54Z
.venv-garmin/bin/python scripts/garmin_fit.py list --days 14 --strength
```

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
