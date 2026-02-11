---
name: analyze
description: Analyze a run and write back to Strava
user-invocable: true
---

# Analyze & Write Back to Strava

1. If no specific activity was mentioned, query the most recent run:
   ```sql
   SELECT id, name, distance, moving_time, start_date_local, average_heartrate
   FROM activities WHERE type='Run'
   ORDER BY start_date_local DESC LIMIT 1
   ```
2. Delegate to the `activity-analyzer` subagent with instructions to:
   - Analyze the workout (query laps, compute splits, assess effort)
   - Ask the athlete for their notes (how it felt, conditions, anything to mention)
   - Generate a preview of proposed Strava changes (name, description)
   - Get explicit confirmation before writing
   - Call `strava_update_activity` to write the analysis back to Strava
3. After write-back, confirm what was written and link to the activity
