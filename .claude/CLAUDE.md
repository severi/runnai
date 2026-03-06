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

## Session Logs
Each session creates a folder under `logs/session-<timestamp>/` with:
- `meta.json` — session metadata (start time, model, session ID, auth type, PID)
- `events.jsonl` — all events in chronological order (JSONL, one JSON object per line)
- `system-prompt.md` — full system prompt snapshot from first exchange
- `tool-results/` — full tool results for large outputs (>1KB), referenced by tool_use_id

### Debugging with session logs
- List sessions: `ls -lt logs/` (newest first)
- Scan events: `cat logs/session-<ts>/events.jsonl | jq .` or filter by type: `jq 'select(.type == "tool_use")' logs/session-<ts>/events.jsonl`
- Find tool calls: `jq 'select(.type == "tool_use") | {tool, tool_use_id, input}' < events.jsonl`
- Find tool results: `jq 'select(.type == "tool_result") | {tool_name, is_error, duration_ms, preview}' < events.jsonl`
- Full tool output: check `tool-results/<tool_use_id>.json` for results >1KB
- Trace a specific tool call: match `tool_use_id` between `tool_use` and `tool_result` events
- Check what the agent said: `jq 'select(.type == "assistant_text") | .text' < events.jsonl`
- Session cost: `jq 'select(.type == "result")' < events.jsonl`

### Event types in events.jsonl
`session_start`, `system_init`, `user_message`, `assistant_text`, `tool_use`, `tool_result`, `can_use_tool`, `result`, `error`, `sdk_message`

## Important
- Use date_calc for ALL date math
- Use calculator for pace/distance calculations
- Check memory before giving advice
- Update memory when learning new information about the athlete
