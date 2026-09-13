---
name: sync
description: Sync latest Strava activities and comment on new runs
user-invocable: true
---

# Strava Sync

1. Call `strava_sync` with NO arguments (uses incremental mode by default — do NOT pass incremental or days)
2. Read the tool result carefully — it tells you exactly which activities are NEW since last sync, with their classification tags
3. Read `data/strava/recent-summary.md` for updated context
4. Present only the NEW information:
   - If the tool says "Already up to date", confirm and give the weekly status
   - If there are new runs, comment on each one:
     - Distance, pace, classification (the [type] tag from sync output)
     - Compare to their training plan if one exists (check data/plans/)
     - Note anything interesting (PR pace, unusually long/short, new classification pattern)
   - If there are new cross-training sessions (rides, walks, ski — the tool says "Cross-training analysis ready"), read each with `get_cross_training_analysis` and the cross-training-analysis skill; for heart-rate sessions use `get_session_analysis`; for lifts follow the strength-session rules
   - Ask: "Want me to update these on Strava with names and coaching notes? (all / pick specific ones / skip)"
   - If yes, use the `strava-writeback` skill to handle the write-back
5. Give a brief weekly summary:
   - Runs so far this week
   - Total km
   - How it compares to planned/typical volume

## Strava Write-Back Safety Rules

- NEVER delete or remove activities from Strava — only update name and description
- ALWAYS preview proposed changes and get explicit confirmation from the user before writing
- The user can cancel or edit any proposed change before it goes live
- Process one run at a time so the user can review each individually

IMPORTANT: Only report NEW activities/runs from the sync. Do NOT list all activities in the database.
