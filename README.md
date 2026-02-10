# RunnAI

AI running coach that genuinely learns about you over time. Every conversation makes it smarter.

Built with the [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript). Connects to Strava, remembers your training history, adapts plans, and tracks your progress across sessions.

## What it does

- **Learns over time** -- 3-tier memory system (hot cache + deep memory + SQLite) means the coach remembers your injury patterns, training preferences, and how you respond to different workloads
- **Strava integration** -- syncs your activities, analyzes runs, tracks best efforts
- **Training plans** -- periodized plans that adapt weekly based on what actually happened
- **Race predictions** -- estimates that evolve as your fitness changes, tracked over time
- **Evidence-based** -- skills for periodization, injury management, workout analysis, and race prediction grounded in running science

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
| `/usage` | Show session token usage and cost |

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
  tools/         MCP tools (Strava, memory, planning, analysis)
  strava/        Strava API client + OAuth
  utils/         SQLite, context builder, sessions
  agent.ts       Agent config, subagents, system prompt

plugins/coach/
  skills/        Domain knowledge (periodization, injury mgmt, etc.)
  commands/      Slash command definitions
  hooks/         Auto-save hooks

data/
  athlete/       CONTEXT.md (hot cache -- always in system prompt)
  memory/        Deep memory (observations, session summaries)
  strava/        SQLite database + OAuth tokens
  plans/         Training plans
  research/      Cached running science lookups
```

### Memory system

The coach manages its own memory (inspired by [MemGPT](https://github.com/cpacker/MemGPT)):

1. **Hot cache** (`data/athlete/CONTEXT.md`) -- ~100 lines, loaded every message. Your profile, goals, current training phase, key metrics.
2. **Deep memory** (`data/memory/`) -- observations, injury history, session summaries. Read on demand.
3. **Structured data** (`data/strava/activities.db`) -- SQLite with all synced activities, queryable by the agent.

The agent decides what to remember, what to promote to the hot cache, and what to archive.

## License

MIT
