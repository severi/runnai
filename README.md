# RunnAI

AI running coach with persistent memory and Strava integration. Learns your patterns, adapts your training, gets smarter every session. Built on the [Claude Agent SDK](https://github.com/anthropics/claude-code).

**[Website](https://severi.github.io/runnai/)**

## What it does

- **Learns over time** -- 3-tier memory system (hot cache + deep memory + SQLite) means the coach remembers your injury patterns, training preferences, and how you respond to different workloads
- **Strava integration** -- syncs activities, classifies runs, writes coaching notes back to your Strava descriptions
- **Deep run analysis** -- per-second stream analysis: HR zone distribution, cardiac drift, grade-adjusted pace, fatigue index, workout phase detection, interval extraction. Every run is automatically classified (easy, tempo, intervals, long, hills)
- **Training plans** -- periodized plans that adapt weekly based on what actually happened, with export to [intervals.icu](https://intervals.icu) (structured workouts, HR/pace targets, color-coded tags)
- **Race predictions** -- estimates that evolve as your fitness changes, tracked over time
- **Weather-aware** -- fetches conditions for your run location to adjust coaching advice
- **Evidence-based** -- skills for periodization, injury management, workout analysis, race prediction, and weekly planning grounded in running science
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
| `/verbose` | Toggle debug panel |

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
  skills/        Domain knowledge (periodization, injury mgmt, strava-writeback, etc.)
  commands/      Slash command definitions

data/
  athlete/       CONTEXT.md (hot cache -- always in system prompt)
  memory/        Deep memory (observations, session summaries)
  strava/        SQLite database + OAuth tokens
  plans/         Training plans
  research/      Cached running science lookups

logs/            Per-session structured logs (JSONL + tool results)
```

### Tools

| Category | Tools |
|----------|-------|
| Strava | `strava_sync`, `strava_profile`, `strava_auth`, `query_activities`, `best_efforts`, `strava_update_activity` |
| Analysis | `get_run_analysis`, `get_activity_streams`, `save_race_prediction`, `get_prediction_history`, `manage_personal_records` |
| Memory | `read_memory`, `write_memory`, `update_context`, `search_memory`, `save_session_summary` |
| Planning | `manage_plan`, `date_calc`, `calculator` |
| Research | `research`, `save_research` |
| HR Zones | `set_hr_zones`, `get_hr_zones` |
| Weather | `get_weather` |
| Intervals.icu | `export_to_intervals`, `push_to_intervals` |

### Memory system

The coach manages its own memory (inspired by [MemGPT](https://github.com/cpacker/MemGPT)):

1. **Hot cache** (`data/athlete/CONTEXT.md`) -- ~100 lines, loaded every message. Your profile, goals, current training phase, key metrics.
2. **Deep memory** (`data/memory/`) -- observations, injury history, session summaries. Read on demand.
3. **Structured data** (`data/strava/activities.db`) -- SQLite with all synced activities, queryable by the agent.

The agent decides what to remember, what to promote to the hot cache, and what to archive.

### Session logs

Each session creates a folder under `logs/session-<timestamp>/` with structured JSONL events. Useful for debugging agent behavior:

```bash
# What tools were called?
jq 'select(.type == "tool_use") | {tool, input}' < events.jsonl

# Any errors?
jq 'select(.type == "tool_result" and .is_error)' < events.jsonl

# What did the agent say?
jq 'select(.type == "assistant_text") | .text' < events.jsonl
```

## Evals

LLM-as-judge evaluation framework using [Promptfoo](https://promptfoo.dev). Tests coaching quality across 3 synthetic athlete profiles (beginner, marathoner, comeback from injury) with rubric-based scoring.

```bash
bun run evals         # Run all test cases
bun run evals:view    # Open results in browser
```

## License

MIT
