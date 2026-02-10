# RunnAI

AI running coach with progressive learning. Uses a 3-tier memory system (hot cache + deep memory + SQLite) and modular skills for coaching knowledge.

## Project Structure
- `src/` — TypeScript source (Agent SDK app)
- `plugins/coach/` — Plugin with skills, commands, hooks
- `data/` — Athlete data, memory, plans, research, Strava data

## Key Files
- `data/athlete/CONTEXT.md` — Hot cache, always in system prompt
- `data/memory/` — Deep memory, agent-managed observations and history
- `data/strava/activities.db` — SQLite with synced Strava activities
- `data/plans/` — Training plan files

## Tools Available
- Strava: strava_auth, strava_sync, strava_profile, query_activities, best_efforts
- Memory: read_memory, write_memory, update_context, search_memory, save_session_summary
- Planning: manage_plan, date_calc, calculator
- Analysis: save_race_prediction, get_prediction_history
- Research: research, save_research

## Important
- Use date_calc for ALL date math
- Use calculator for pace/distance calculations
- Check memory before giving advice
- Update memory when learning new information about the athlete
