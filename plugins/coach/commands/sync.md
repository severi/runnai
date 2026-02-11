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
   - Offer to analyze and write back to Strava: "Want me to analyze these runs and write summaries to your Strava activities?"
   - If they say yes, use the activity-analyzer subagent for each run (follows the write-back flow: ask for notes, preview, confirm, write)
4. Give a brief weekly summary:
   - Runs so far this week
   - Total km
   - How it compares to planned/typical volume
5. If already up to date, just confirm and give the weekly status
