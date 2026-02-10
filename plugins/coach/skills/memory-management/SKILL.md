---
name: memory-management
description: Teaches the agent how to manage its 3-tier memory system for progressive learning about the athlete
---

# Memory Management

You have a 3-tier memory system that enables progressive learning about your athlete. Managing this memory well is core to being a great coach.

## Tier Architecture

### Tier 1: Hot Cache (CONTEXT.md)
- **Always in your system prompt** - you see it every message
- Located at `data/athlete/CONTEXT.md`
- Maximum 100 lines / ~3KB
- Contains: profile, current goals, training phase, key metrics, active concerns, preferences
- Update via `update_context` tool

### Tier 2: Deep Memory (data/memory/)
- **Loaded on demand** when relevant to conversation
- You read/write these files autonomously
- Files: `observations.md`, `training-history.md`, `injury-log.md`, `glossary.md`, `race-predictions/`, `session-summaries/`
- Access via `read_memory`, `write_memory`, `search_memory` tools

### Tier 3: Structured Data (SQLite)
- Activities database at `data/strava/activities.db`
- Best efforts and race predictions tables
- Access via `query_activities`, `best_efforts`, `save_race_prediction`, `get_prediction_history` tools

## When to Update Hot Cache (CONTEXT.md)

Update CONTEXT.md when any of these change:
- Training phase (e.g., moving from base to build)
- Primary goal or target race
- Key metrics (pace zones, predicted times)
- Active injury or concern status
- Weekly volume target

Do NOT update CONTEXT.md for:
- Individual workout notes (-> observations.md)
- Historical events (-> training-history.md)
- Temporary information that will be stale in a week

## When to Write to Deep Memory

### observations.md
Write when you notice patterns:
- "Tends to go too fast on easy days"
- "Responds well to 2-week build / 1-week recovery cycles"
- "Left Achilles flares up after consecutive hard days"
- "Prefers morning runs, struggles with afternoon intensity"
- "Gets anxious before races but performs well"

### training-history.md
Write for significant milestones:
- New PRs achieved
- Major plan changes and why
- Injury episodes (onset, duration, resolution)
- Race results and analysis
- Training block completions

### injury-log.md
Write when:
- New injury or pain reported
- Existing injury status changes
- Recovery milestone reached
- Preventive measures discussed

### race-predictions/
Write when fitness assessment is done. Track evolution over time.

### session-summaries/
Write at the end of every significant conversation. Include:
- Key topics discussed
- Decisions made
- Plan adjustments
- New information learned about the athlete
- Open questions for next session

## Memory Lookup Flow

When you need information about the athlete:
1. **Check hot cache** (CONTEXT.md) - it's already in your prompt
2. **Search deep memory** (`search_memory`) if the answer isn't in the hot cache
3. **Query SQLite** (`query_activities`) for training data questions
4. **Ask the athlete** if you still can't find it

Never make assumptions about the athlete without checking memory first.

## Promotion and Demotion

**Promote to hot cache** when:
- An observation is referenced in 3+ sessions
- A concern becomes the primary focus of training
- A metric changes significantly

**Demote from hot cache** when:
- A goal is completed (move to training-history.md)
- An injury is resolved (move to injury-log.md)
- Information hasn't been relevant for 4+ weeks

## What's Worth Remembering vs Noise

**Remember:**
- Patterns in behavior, performance, or health
- Stated preferences and constraints
- Significant training adaptations
- Emotional responses to training
- Life circumstances affecting training

**Don't remember:**
- Individual daily paces (that's in SQLite)
- Generic coaching advice you gave
- Routine sync results with no anomalies
- Small talk unrelated to training

## Session End Protocol

Before a conversation ends:
1. Check if you learned anything new about the athlete
2. If yes, write relevant observations to deep memory
3. If training phase or goals changed, update CONTEXT.md
4. Write a session summary with `save_session_summary`
