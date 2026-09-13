# RunnAI

AI running coach with persistent memory and Strava integration. Learns your patterns, adapts your training, gets smarter every session. Built on the [Claude Agent SDK](https://github.com/anthropics/claude-code).

**[Website](https://severi.github.io/runnai/)**

## What it does

- **Learns over time** -- 3-tier memory system (hot cache + deep memory + SQLite) means the coach remembers your injury patterns, training preferences, and how you respond to different workloads
- **Strava integration** -- syncs activities, classifies runs, writes coaching notes back to your Strava descriptions
- **Deep run analysis** -- per-second stream analysis: HR zone distribution, cardiac drift, grade-adjusted pace, fatigue index, workout phase detection, interval extraction. Every run is automatically classified (easy, tempo, intervals, long, hills)
- **Grade-aware, walk-aware metrics** -- pace fade is measured on Minetti grade-adjusted speed, and run/walk decomposition separates "the running slowed" from "there was more walking". A downhill start and an uphill finish don't get reported as a fade
- **Strength training** -- Strava's API exposes nothing about a gym session beyond duration and HR, so the original Garmin FIT file is fetched and parsed for per-set exercise, reps, weight and true rest intervals
- **Training plans** -- periodized plans that adapt weekly based on what actually happened, with versioned revisions, an audit changelog, plan-vs-actual compliance, and export to [intervals.icu](https://intervals.icu) (structured workouts, HR/pace targets, color-coded tags)
- **Self-correcting zones** -- detects when your easy pace has drifted away from your stored zones, proposes an update with the evidence, and keeps an audit trail of every change
- **Race predictions** -- estimates that evolve as your fitness changes, tracked over time
- **Weather-aware** -- fetches conditions for your run location to adjust coaching advice
- **Evidence-based** -- skills for periodization, injury management, workout analysis, race prediction, weekly planning and zone calibration, grounded in running science
- **Reviewed before it reaches you** -- every run analysis is checked by a separate reviewer agent against the underlying data, so claims the numbers don't support get caught before they're presented as coaching
- **Session logging** -- structured JSONL logs for debugging agent behavior

## Setup

### Prerequisites

- [Bun](https://bun.sh) v1.x
- A [Strava API application](https://www.strava.com/settings/api) (set callback domain to `localhost`)
- Either an [Anthropic API key](https://console.anthropic.com) or [Claude Code](https://claude.ai/code) installed (see Authentication below)

### Install

```bash
git clone https://github.com/severi/runnai.git
cd runnai
bun install
```

### Authentication

Two options -- pick one:

**Option A: Claude account (Pro/Max subscription)**
```bash
claude login  # one-time, authenticates via browser
```

**Option B: API key (pay-per-token)**
```bash
cp .env.example .env
# Add your ANTHROPIC_API_KEY from console.anthropic.com
```

### Strava

Add your Strava app credentials to `.env`:

```
STRAVA_CLIENT_ID=your_client_id
STRAVA_CLIENT_SECRET=your_client_secret
```

### Run

```bash
bun run build
bun run start
```

The coach will walk you through onboarding on first run -- connecting Strava, syncing your data, and building your profile.

## Usage

### Commands

| Command | Description |
|---------|-------------|
| `/setup` | Initial setup -- connect Strava, build profile |
| `/sync [days]` | Sync recent Strava activities |
| `/plan [goal]` | Create or update a training plan |
| `/progress [period]` | Review training progress |
| `/race [distance]` | Race time predictions |
| `/research [topic]` | Look up running science |
| `/analyze [run]` | Deep-dive analysis of a specific run |
| `/usage` | Show session token usage and cost |
| `/context` | Show what's currently in the hot cache |
| `/login` | Authenticate with Claude in-session |
| `/verbose` | Toggle debug panel |

### Strength sessions (optional)

Strava's public API exposes no exercises, sets, reps or weights for a gym session -- its app shows them by parsing the uploaded FIT file, but that data has never been in the v3 API. The original Garmin file does carry it, so it's fetched directly:

```bash
python3 -m venv .venv-garmin
.venv-garmin/bin/pip install -r scripts/requirements-garmin.txt
.venv-garmin/bin/python scripts/garmin_fit.py fetch --at 2026-08-03T18:07:54Z
bun scripts/parse-fit.ts data/fit/<id>_ACTIVITY.fit
```

Sign-in happens on demand and caches tokens, so it's asked for once. Activities are matched by start time, since Strava and Garmin share no id.

### Resume sessions

```bash
bun run start -- --resume
```

Picks up where you left off with full chat history.

### Reset

```bash
bun run reset        # Clear profile & memory, keep Strava data
bun run reset:all    # Full reset including Strava database
```

## Architecture

```
src/
  cli/           React/Ink terminal UI
  tools/         MCP tools (Strava, memory, analysis, planning, weather, intervals.icu)
  strava/        Strava API client + OAuth
  utils/         Stream analysis, run classification, context builder, sessions
  mcp/           MCP server setup
  agent.ts       Agent config, subagents, system prompt

plugins/coach/
  skills/        Domain knowledge (periodization, injury mgmt, workout analysis,
                 zone calibration, strava-writeback, strength FIT import, etc.)
  commands/      Slash command definitions

scripts/
  garmin_fit.py  Fetch original FIT files from Garmin (strength set data)
  parse-fit.ts   Parse a strength FIT into sets, reps, load and rest

data/            (its own git repo -- snapshotted by commit_data)
  athlete/       CONTEXT.md (hot cache -- always in system prompt)
  memory/        Deep memory (observations, session summaries, strength log)
  strava/        SQLite database + OAuth tokens
  plans/         Training plans (plan.md, CHANGELOG.md, versions/, references/)
  fit/           Downloaded Garmin FIT files
  research/      Cached running science lookups

logs/            One JSONL file per session
```

### Tools

| Category | Tools |
|----------|-------|
| Strava | `strava_sync`, `strava_profile`, `strava_auth`, `query_activities`, `best_efforts`, `strava_update_activity`, `get_gear` |
| Analysis | `get_run_analysis`, `save_run_analysis`, `get_session_analysis`, `get_cross_training_analysis`, `get_activity_streams`, `generate_aerobic_chart`, `save_race_prediction`, `get_prediction_history`, `manage_personal_records` |
| Memory | `read_memory`, `write_memory`, `update_context`, `search_memory`, `save_session_summary` |
| Planning | `manage_plan`, `get_plan_compliance`, `attach_reference`, `date_calc`, `calculator` |
| Zones | `get_training_zones`, `set_hr_zones`, `get_hr_zones`, `update_pace_zones`, `get_zone_history`, `get_fitness_drift` |
| Research | `research`, `save_research`, `link_research` |
| Weather | `get_weather` |
| Intervals.icu | `export_to_intervals`, `push_to_intervals`, `list_intervals_events`, `delete_intervals_event`, `reconcile_intervals_plan` |
| Data | `commit_data` |

### Memory system

The coach manages its own memory (inspired by [MemGPT](https://github.com/cpacker/MemGPT)):

1. **Hot cache** (`data/athlete/CONTEXT.md`) -- ~100 lines, loaded every message. Your profile, goals, current training phase, key metrics.
2. **Deep memory** (`data/memory/`) -- observations, injury history, session summaries. Read on demand.
3. **Structured data** (`data/strava/activities.db`) -- SQLite with all synced activities, queryable by the agent.

The agent decides what to remember, what to promote to the hot cache, and what to archive.

### Session logs

Each session writes a single JSONL file at `logs/<session-id>.jsonl` in Claude Code format. Every event carries `type`, `uuid`, `parentUuid`, `sessionId`, `version` and `timestamp`, so a session can be replayed or diffed after the fact. Event types: `user`, `assistant` (raw API response with per-turn `usage`), `system` (subtypes `init`, `result`, `turn_duration`, `task_progress`, …), `progress`.

```bash
# What tools were called?
jq 'select(.type=="assistant") | .message.content[] | select(.type=="tool_use") | {name, input}' < logs/<id>.jsonl

# What did the coach actually say?
jq 'select(.type=="assistant") | .message.content[] | select(.type=="text") | .text' < logs/<id>.jsonl

# Per-turn token usage, and the session's cost
jq 'select(.type=="assistant") | .message.usage' < logs/<id>.jsonl
jq 'select(.subtype=="result")' < logs/<id>.jsonl
```

These are the primary debugging surface: most of the coaching-quality work in this project came from reading a session back and finding where the agent's reasoning diverged from the data.

## Evals

LLM-as-judge evaluation framework using [Promptfoo](https://promptfoo.dev). Tests coaching quality across 3 synthetic athlete profiles (beginner, marathoner, comeback from injury) with rubric-based scoring.

```bash
bun run evals         # Run all test cases
bun run evals:view    # Open results in browser
```

## License

MIT
