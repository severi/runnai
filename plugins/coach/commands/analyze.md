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
2. Use the `strava-writeback` skill to generate previews and write back
3. After write-back, confirm what was written
