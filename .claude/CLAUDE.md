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
Each session creates a single JSONL file at `logs/<session-id>.jsonl` (Claude Code format). Every event carries: `type`, `uuid`, `parentUuid`, `sessionId`, `version`, `timestamp`.

### Event types
- **`user`** — user messages: `message: { role: "user", content: "..." }`
- **`assistant`** — raw API response with content blocks + per-turn `usage` (tokens, cache hits)
- **`system`** — subtypes: `session_start`, `init`, `system_prompt`, `can_use_tool`, `turn_duration`, `result`, `error`
- **`progress`** — reserved for future use

### Debugging with session logs
- List sessions: `ls -lt logs/*.jsonl`
- Scan events: `jq . < logs/<id>.jsonl`
- Event types: `jq -r .type < logs/<id>.jsonl | sort | uniq -c`
- Assistant messages: `jq 'select(.type == "assistant") | .message.content[] | select(.type == "text") | .text' < logs/<id>.jsonl`
- Tool calls: `jq 'select(.type == "assistant") | .message.content[] | select(.type == "tool_use") | {name, input}' < logs/<id>.jsonl`
- Tool results: `jq 'select(.type == "user" and .tool_name) | {tool_name, duration_ms}' < logs/<id>.jsonl`
- Per-turn tokens: `jq 'select(.type == "assistant") | .message.usage' < logs/<id>.jsonl`
- Turn durations: `jq 'select(.subtype == "turn_duration") | .durationMs' < logs/<id>.jsonl`
- Session cost: `jq 'select(.subtype == "result")' < logs/<id>.jsonl`
- Event tree: `jq '{uuid: .uuid[:8], parent: .parentUuid[:8]?, type, subtype}' < logs/<id>.jsonl`

## Important
- Use date_calc for ALL date math
- Use calculator for pace/distance calculations
- Check memory before giving advice
- Update memory when learning new information about the athlete
