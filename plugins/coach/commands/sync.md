---
name: sync
description: Sync latest Strava activities and comment on new runs
user-invocable: true
---

# Strava Sync

1. Run `strava_sync` in incremental mode (default)
2. Read `data/strava/recent-summary.md` for updated context
3. If there are new runs since last sync:
   - Comment specifically on each new run (pace, distance, name)
   - Compare to their training plan if one exists (check data/plans/)
   - Note anything interesting (PR pace, unusually long/short, etc.)
4. Give a brief weekly summary:
   - Runs so far this week
   - Total km
   - How it compares to planned/typical volume
5. If already up to date, just confirm and give the weekly status
