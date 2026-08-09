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
2. Run the full **New Run Analysis** flow from the system prompt (Phase 1: gather → triage → draft thorough coaching analysis → review → save full analysis → post the chat read → stop). Use the `workout-analysis` skill as the domain reference (assessment framework, evidence gate, comparison triggers).
3. **Do NOT push to Strava in this command.** End the response with the chat read posted (full analysis saved, available on request). The athlete may iterate, ask for revisions, or later request a Strava push — that triggers the strava-writeback skill in a separate turn.
