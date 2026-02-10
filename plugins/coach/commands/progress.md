---
name: progress
description: Weekly progress review - planned vs actual
user-invocable: true
---

# Progress Review

1. Sync latest Strava data using `strava_sync`

2. Delegate to progress-reviewer subagent:
   - Compare this week's planned workouts vs what actually happened
   - Calculate volume, intensity distribution, and training load

3. Read memory for any noted concerns:
   - `search_memory` for recent observations
   - Check CONTEXT.md for active concerns

4. Present the review:
   - **This week**: runs completed, total km, key workouts hit/missed
   - **Planned vs actual**: specific comparison with the training plan
   - **Trends**: volume and intensity over last 3-4 weeks
   - **Observations**: anything notable (pace improvements, fatigue signs, etc.)

5. Look ahead:
   - What's planned for next week
   - Any adjustments recommended based on this week
   - Check for upcoming races or milestones with `date_calc`

6. Update memory if needed:
   - Write relevant observations
   - Update CONTEXT.md if training phase changed
