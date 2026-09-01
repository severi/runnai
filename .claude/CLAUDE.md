# RunnAI

AI running coach with progressive learning. Uses a 3-tier memory system (hot cache + deep memory + SQLite) and modular skills for coaching knowledge.

## Project Structure
- `src/` — TypeScript source (Agent SDK app)
- `plugins/coach/` — Plugin with skills, commands, hooks
- `data/` — Athlete data, memory, plans, research, Strava data

## Key Files
- `data/athlete/CONTEXT.md` — Hot cache, always in system prompt
- `data/athlete/goals.json` — Goal hierarchy (north star → horizon → event), rendered as `## Goals` in the system prompt
- `data/memory/` — Deep memory, agent-managed observations and history
- `data/strava/activities.db` — SQLite with synced Strava activities
- `data/plans/` — Training plan files

## Tools Available
- Strava: strava_auth, strava_sync, strava_profile, query_activities, best_efforts
- Memory: read_memory, write_memory, update_context, search_memory, save_session_summary
- Planning: manage_plan, date_calc, calculator
- Goals: manage_goals (north star / horizon / event hierarchy in `data/athlete/goals.json`, rendered into the system prompt; guides, never restricts)
- Analysis: save_race_prediction, get_prediction_history
- Sessions: get_session_analysis (heart-rate-only sessions — basketball, tennis, padel; bouts, floors, drift, same-sport history; `save_run_analysis` routes `detailed_analysis` to the session record)
- Gear: get_gear (shoe mileage — Strava-authoritative, never quote cached km)
- Research: research, save_research

## Session Logs
Each session creates a single JSONL file at `logs/<session-id>.jsonl` (Claude Code format). Every event carries: `type`, `uuid`, `parentUuid`, `sessionId`, `version`, `timestamp`.

### Event types
- **`user`** — user messages: `message: { role: "user", content: "..." }`
- **`assistant`** — raw API response with content blocks + per-turn `usage` (tokens, cache hits)
- **`system`** — subtypes: `session_start`, `init`, `system_prompt`, `can_use_tool`, `turn_duration`, `result`, `error`, `task_started`, `task_progress`, `task_notification`, `background_tasks_changed`, `style_lint`, `model_refusal_fallback`, `model_refusal_no_fallback`, `worker_shutting_down`
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

## Privacy — no real athlete data in tracked files
This repo is public. Real athlete data lives ONLY in `data/` and `.private/` (both gitignored). Anything committed to git — source, tests, docs, tool descriptions, comments — must use the synthetic persona instead:
- Name "Alex"; races "Rotterdam Marathon", "Trail Ultra 100km", "Forest Classic Trail Marathon"; plan slugs `rotterdam-marathon-2026`, `forest-hybrid-2026`
- Never commit the athlete's real races, race names, result/target times, HR zones, lab-test details, or real Strava activity IDs (use fake IDs like 90000000001)
- Don't hardcode athlete-specific numbers in prompts or tool descriptions — read them from CONTEXT.md / data files at runtime
- When writing a test from a real debugging incident, genericize the story ("a 100km ultra") — keep the lesson, drop the identity

## Important
- Use date_calc for ALL date math
- Use calculator for pace/distance calculations
- Check memory before giving advice
- Update memory when learning new information about the athlete
