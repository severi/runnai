---
name: analyze
description: Run the full coaching analysis on a run; Strava push happens later only if the athlete asks
user-invocable: true
---

# Analyze a Run

1. If no specific activity was mentioned, query the most recent run:
   ```sql
   SELECT id, name, distance, moving_time, start_date_local, average_heartrate
   FROM activities WHERE type='Run'
   ORDER BY start_date_local DESC LIMIT 1
   ```
2. Run the full **New Run Analysis** flow from the system prompt (Phase 1: gather → triage → draft thorough coaching analysis → review → save → post in chat → stop). Use the `workout-analysis` skill for the depth structure and cross-run comparison guidance.
3. **Do NOT push to Strava in this command.** End the response with the coaching analysis posted to chat. The athlete may iterate, ask for revisions, or later request a Strava push — that triggers the strava-writeback skill in a separate turn.
