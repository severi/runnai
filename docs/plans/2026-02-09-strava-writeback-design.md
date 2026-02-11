# Strava Write-Back

## Problem

After the agent analyzes a workout, the insights live only in the chat. They should flow back to Strava where the athlete (and their followers) can see them. This is also the primary viral channel — Strava followers see detailed AI analysis and discover RunnAI.

## Design

### New Tool: `strava_update_activity`

**Params:**
- `activity_id` (number, required)
- `name` (string, optional) — rename to something descriptive (e.g. "Easy Recovery 8K")
- `description` (string, optional) — AI analysis with user notes woven in
- `private_note` (string, optional) — coach observations only the athlete sees

All fields optional beyond the ID. Only updates what's provided.

### Attribution

Append to every description:

```
Analysis by RunnAI · github.com/severi/runnai
```

### OAuth Scope

Add `activity:write` to the scope in `src/strava/client.ts`. Existing users need to re-auth. If PUT returns 403, prompt user to re-auth via `/setup`.

## Flow

### Triggers

1. **After `/sync`** — agent auto-offers analysis + write-back for newly synced activities
2. **`/analyze [activity]`** — manual trigger for any activity

### Interaction

1. Agent analyzes the workout (pace, HR, splits, effort structure)
2. Agent asks: "Any notes about this run? How did it feel?" — captures subjective input (perceived effort, niggles, conditions, context)
3. Agent generates a **preview**:
   - **Name:** `Tempo 10K — Progression Finish` (was: "Afternoon Run")
   - **Description:** Analysis incorporating user's notes + attribution footer
   - **Private note:** Coach-only observations (load concerns, pattern notes)
4. User approves, edits, or skips each field
5. On approval, calls `strava_update_activity`

## Implementation

### Files to Change

1. **`src/strava/client.ts`**
   - Add `activity:write` to OAuth scope
   - Add `updateActivity(id, { name?, description?, private_note? })` method
   - `PUT https://www.strava.com/api/v3/activities/{id}`

2. **`src/tools/strava.ts`**
   - New `stravaUpdateActivityTool` — validates params, appends attribution to description, calls client method
   - Export and register in `src/tools/index.ts` + `src/mcp/server.ts`

3. **`src/agent.ts`**
   - Update `activity-analyzer` subagent prompt to include write-back flow
   - Add `strava_update_activity` to its tools list

4. **`plugins/coach/commands/analyze.md`**
   - New `/analyze` slash command

5. **`plugins/coach/commands/sync.md`**
   - Update to mention post-sync analysis offering

## Not Building (for now)

- Auto-write without user confirmation
- Batch write-back for multiple activities at once
- Custom attribution text
- Image/chart attachments to Strava
