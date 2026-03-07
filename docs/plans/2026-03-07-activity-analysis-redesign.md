# Activity Analysis & Strava Writeback Redesign

**Date:** 2026-03-07
**Status:** Approved

## Problem

The current Strava activity updates are too simplistic:
1. A 26km Z2 run gets labeled "easy" — ignoring the training load significance
2. "Comfortably in Z2" when reality includes Z3 on uphills — flattening the experience
3. Titles are rigid copies of template examples
4. No detailed analysis stored locally — only a brief prose summary
5. Prose is generated at sync time without athlete context (goals, plan, recent training)

## Design Decisions

- **Agent-time analysis** — The coaching agent writes the analysis at conversation time, not at sync time. This gives it access to athlete context (CONTEXT.md, training plan, goals, recent history).
- **Two-stage output** — Stage 1: detailed coaching analysis (1-2 paragraphs). Stage 2: condensed Strava title + description distilled from the detailed analysis.
- **Full data, no pre-filtering** — `get_run_analysis` provides all computed metrics. The agent decides what matters, not the code.
- **Guidelines over templates** — The skill defines principles (short, no emoji, coaching tone) but no rigid title format. The agent develops its own voice.
- **SQLite storage** — Detailed analysis, Strava title, and Strava description stored in `activity_analysis` table.
- **Enriched training context** — `get_run_analysis` includes surrounding training data (weekly volume, frequency, distance/elevation ranks, TRIMP context).

## Architecture

### Data Flow

```
Sync time (deterministic, unchanged):
  Strava API → strava_sync → SQLite
    - activities, laps, streams, best_efforts
    - classifyRun() → run_type, hill_category
    - computeActivityAnalysis() → pace, GAP, elevation, comparisons
    - computeStreamAnalysis() → HR zones, cardiac drift, phases, intervals, TRIMP

Conversation time (new):
  Agent calls get_run_analysis(activity_id)
    → All metrics + training context (weekly volume, TRIMP context, distance ranks)
  Agent considers athlete context (CONTEXT.md, plan, goals)
  Agent writes detailed analysis → stored in activity_analysis.detailed_analysis
  Agent condenses to Strava title + description → stored, previewed, approved, written
```

### Changes

#### 1. Enrich `get_run_analysis` output

Add `training_context` block with fields computed from surrounding activities:

```typescript
training_context: {
  days_since_last_run: number | null,
  runs_last_7d: number,
  km_last_7d: number,
  runs_last_14d: number,
  km_last_14d: number,
  is_longest_run_30d: boolean,
  is_longest_run_7d: boolean,
  longest_run_30d_km: number | null,
  elevation_rank_30d: number | null,
  moving_time_min: number,
  trimp_7d_total: number | null,
  trimp_percentile_30d: number | null,
}
```

All existing metrics remain in the output — no filtering.

#### 2. Remove sync-time prose generation

- Remove `generateProseSummary()` function and its call from the sync pipeline
- Remove `buildProsePrompt()` and helper functions (`summarizeVerticalPhases`, `formatDuration`)
- These are replaced by agent-time analysis

#### 3. Rewrite strava-writeback skill

Two-stage guidelines-based skill:

**Stage 1 — Detailed Analysis:**
- Call `get_run_analysis(activity_id)` for full structured data
- Consider athlete context (CONTEXT.md, training plan, goals)
- Write 1-2 paragraph coaching analysis covering:
  - What the run actually was (type, terrain, structure)
  - Training load significance (TRIMP in context of recent training)
  - Zone honesty — describe what happened on the course, not just aggregates
  - Notable signals (cardiac drift, fatigue, pacing, historical comparisons)
  - How it fits into the training week/plan
- Store in `activity_analysis.detailed_analysis`

**Stage 2 — Strava Distillation:**
- Condense the detailed analysis into:
  - Title: short, descriptive, principles-based (no rigid format)
  - Description: 2-4 sentences, plain prose, coaching voice
- Store in `activity_analysis.strava_title` / `strava_description`

**Stage 3 — Preview & Approval:**
- Show user both detailed analysis and Strava preview
- On approval, call `strava_update_activity`

**Skill principles (not templates):**
- Titles: short, no emoji, no stats dumps, no plan references. Agent's own voice.
- Descriptions: plain prose, no headers/bullets/emoji, coaching insight not data readback.
- Analysis: "Analyze like a coach reviewing the file. A 26km Z2 run with hill-driven Z3 segments is not 'easy' — it's a significant aerobic session with terrain-driven intensity variation."

#### 4. SQLite schema changes

**Add columns to `activity_analysis`:**
- `detailed_analysis TEXT`
- `strava_title TEXT`
- `strava_description TEXT`
- `analysis_generated_at TEXT`

**Remove columns:**
- `prose_summary TEXT`
- `prose_generated_at TEXT`

#### 5. User-facing flow

- User syncs → deterministic metrics computed (same as today)
- User asks about a run OR triggers writeback → agent produces detailed analysis
- Same analysis output whether it ends up on Strava or not
- If analysis already exists in SQLite, agent retrieves it instead of regenerating
- User can always ask for more details — agent queries raw data directly
