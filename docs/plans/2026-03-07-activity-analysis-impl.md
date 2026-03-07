# Activity Analysis Redesign - Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace sync-time prose generation with agent-time two-stage analysis (detailed coaching analysis + Strava distillation), enriched with training context.

**Architecture:** Enrich `get_run_analysis` with training context from surrounding activities. Remove LLM prose generation from sync. Add a `save_run_analysis` tool for the agent to persist its analysis. Rewrite strava-writeback skill as guidelines-based two-stage flow.

**Tech Stack:** TypeScript, Bun SQLite, Agent SDK tools, plugin skills

---

### Task 1: Schema migration — add new columns, rename old ones

**Files:**
- Modify: `src/utils/activities-db.ts:205-231` (activity_analysis table + migrations)
- Modify: `src/types/index.ts:226-249` (ActivityAnalysisRecord interface)

**Step 1: Add migration blocks for new columns in `activities-db.ts`**

After the existing `activity_analysis` CREATE TABLE block (line ~231), add migrations:

```typescript
// Migration: rename prose columns → new analysis columns
try {
  db.exec("ALTER TABLE activity_analysis ADD COLUMN detailed_analysis TEXT");
} catch {
  // Column already exists
}
try {
  db.exec("ALTER TABLE activity_analysis ADD COLUMN strava_title TEXT");
} catch {
  // Column already exists
}
try {
  db.exec("ALTER TABLE activity_analysis ADD COLUMN strava_description TEXT");
} catch {
  // Column already exists
}
try {
  db.exec("ALTER TABLE activity_analysis ADD COLUMN analysis_generated_at TEXT");
} catch {
  // Column already exists
}
```

**Step 2: Update `ActivityAnalysisRecord` type in `src/types/index.ts`**

Replace `prose_summary` and `prose_generated_at` with the new fields:

```typescript
export interface ActivityAnalysisRecord {
  activity_id: number;
  run_type: string;
  run_type_detail: string | null;
  classification_confidence: string;
  hill_category: string | null;
  distance_m: number;
  moving_time_s: number;
  pace_sec_per_km: number;
  elevation_gain_m: number | null;
  elevation_loss_m: number | null;
  grade_adjusted_pace_sec_per_km: number | null;
  avg_heartrate: number | null;
  max_heartrate: number | null;
  lap_summaries: LapSummary[];
  similar_runs_7d: number;
  similar_runs_30d: number;
  avg_pace_similar_30d: number | null;
  pace_vs_similar_delta: number | null;
  // Old columns kept for backward compat with existing DB rows
  prose_summary: string | null;
  prose_generated_at: string | null;
  // New columns
  detailed_analysis: string | null;
  strava_title: string | null;
  strava_description: string | null;
  analysis_generated_at: string | null;
  analyzed_at: string;
  analysis_version: number;
}
```

**Step 3: Update `computeActivityAnalysis` in `src/utils/activity-analysis.ts`**

Add the new fields to the analysis record construction (around line 125-148):

```typescript
// Add to the analysis object:
detailed_analysis: null,
strava_title: null,
strava_description: null,
analysis_generated_at: null,
```

**Step 4: Update `saveActivityAnalysis` in `src/utils/activity-analysis.ts`**

Add the new columns to the INSERT statement (around line 165-206). Add `detailed_analysis`, `strava_title`, `strava_description`, `analysis_generated_at` to both the column list and VALUES.

**Step 5: Verify it compiles**

Run: `cd /Users/severi/code/personal/runnai && bun build src/index.ts --no-bundle 2>&1 | head -20`
Expected: No type errors related to ActivityAnalysisRecord

**Step 6: Commit**

```bash
git add src/utils/activities-db.ts src/types/index.ts src/utils/activity-analysis.ts
git commit -m "feat: add schema columns for detailed analysis and strava writeback"
```

---

### Task 2: Add `computeTrainingContext()` function

**Files:**
- Modify: `src/utils/activity-analysis.ts` (add function after `getRecentUnanalyzedActivityIds`)

**Step 1: Add the `TrainingContext` interface to `src/types/index.ts`**

```typescript
export interface TrainingContext {
  days_since_last_run: number | null;
  runs_last_7d: number;
  km_last_7d: number;
  runs_last_14d: number;
  km_last_14d: number;
  is_longest_run_30d: boolean;
  is_longest_run_7d: boolean;
  longest_run_30d_km: number | null;
  elevation_rank_30d: number | null;
  moving_time_min: number;
  trimp_7d_total: number | null;
  trimp_percentile_30d: number | null;
}
```

**Step 2: Implement `computeTrainingContext()` in `src/utils/activity-analysis.ts`**

```typescript
import type { TrainingContext } from "../types/index.js";

export function computeTrainingContext(
  activityId: number,
  db: Database
): TrainingContext | null {
  const activity = db.prepare(`
    SELECT id, distance, moving_time, start_date_local
    FROM activities WHERE id = ?
  `).get(activityId) as {
    id: number; distance: number; moving_time: number; start_date_local: string;
  } | undefined;
  if (!activity) return null;

  const runDate = activity.start_date_local;

  // Days since last run
  const prevRun = db.prepare(`
    SELECT start_date_local FROM activities
    WHERE type = 'Run' AND trainer = 0
      AND start_date_local < ? AND id != ?
    ORDER BY start_date_local DESC LIMIT 1
  `).get(runDate, activityId) as { start_date_local: string } | undefined;

  const daysSinceLastRun = prevRun
    ? Math.round((new Date(runDate).getTime() - new Date(prevRun.start_date_local).getTime()) / 86400000)
    : null;

  // Runs and km in last 7d and 14d
  const windowStats = db.prepare(`
    SELECT
      SUM(CASE WHEN start_date_local >= date(?, '-7 days') THEN 1 ELSE 0 END) as runs_7d,
      SUM(CASE WHEN start_date_local >= date(?, '-7 days') THEN distance ELSE 0 END) as km_7d,
      COUNT(*) as runs_14d,
      SUM(distance) as km_14d
    FROM activities
    WHERE type = 'Run' AND trainer = 0
      AND start_date_local >= date(?, '-14 days')
      AND start_date_local < ? AND id != ?
  `).get(runDate, runDate, runDate, runDate, activityId) as {
    runs_7d: number; km_7d: number; runs_14d: number; km_14d: number;
  };

  // Distance ranking
  const longestIn30d = db.prepare(`
    SELECT MAX(distance) as max_dist FROM activities
    WHERE type = 'Run' AND trainer = 0
      AND start_date_local >= date(?, '-30 days')
      AND start_date_local <= ? AND id != ?
  `).get(runDate, runDate, activityId) as { max_dist: number | null };

  const longestIn7d = db.prepare(`
    SELECT MAX(distance) as max_dist FROM activities
    WHERE type = 'Run' AND trainer = 0
      AND start_date_local >= date(?, '-7 days')
      AND start_date_local <= ? AND id != ?
  `).get(runDate, runDate, activityId) as { max_dist: number | null };

  // Elevation ranking (count of runs with more elevation in 30d)
  const elevRank = db.prepare(`
    SELECT COUNT(*) + 1 as rank FROM activities
    WHERE type = 'Run' AND trainer = 0
      AND start_date_local >= date(?, '-30 days')
      AND start_date_local <= ? AND id != ?
      AND total_elevation_gain > (SELECT total_elevation_gain FROM activities WHERE id = ?)
  `).get(runDate, runDate, activityId, activityId) as { rank: number };

  const totalRunsIn30d = db.prepare(`
    SELECT COUNT(*) as cnt FROM activities
    WHERE type = 'Run' AND trainer = 0
      AND start_date_local >= date(?, '-30 days')
      AND start_date_local <= ?
  `).get(runDate, runDate) as { cnt: number };

  // TRIMP context
  const trimp7d = db.prepare(`
    SELECT SUM(sa.trimp) as total FROM activity_stream_analysis sa
    JOIN activities a ON sa.activity_id = a.id
    WHERE a.type = 'Run' AND a.trainer = 0
      AND a.start_date_local >= date(?, '-7 days')
      AND a.start_date_local < ? AND a.id != ?
  `).get(runDate, runDate, activityId) as { total: number | null };

  // This activity's TRIMP
  const thisTrimp = db.prepare(`
    SELECT trimp FROM activity_stream_analysis WHERE activity_id = ?
  `).get(activityId) as { trimp: number | null } | undefined;

  // TRIMP percentile: count of runs with lower TRIMP in 30d
  let trimpPercentile: number | null = null;
  if (thisTrimp?.trimp != null) {
    const trimpRank = db.prepare(`
      SELECT COUNT(*) as below, (SELECT COUNT(*) FROM activity_stream_analysis sa2
        JOIN activities a2 ON sa2.activity_id = a2.id
        WHERE a2.type = 'Run' AND a2.trainer = 0
          AND a2.start_date_local >= date(?, '-30 days')
          AND a2.start_date_local <= ?) as total
      FROM activity_stream_analysis sa
      JOIN activities a ON sa.activity_id = a.id
      WHERE a.type = 'Run' AND a.trainer = 0
        AND a.start_date_local >= date(?, '-30 days')
        AND a.start_date_local <= ?
        AND sa.trimp < ?
    `).get(runDate, runDate, runDate, runDate, thisTrimp.trimp) as { below: number; total: number };
    if (trimpRank.total > 0) {
      trimpPercentile = Math.round((trimpRank.below / trimpRank.total) * 100);
    }
  }

  return {
    days_since_last_run: daysSinceLastRun,
    runs_last_7d: windowStats.runs_7d ?? 0,
    km_last_7d: Math.round((windowStats.km_7d ?? 0) / 10) / 100,
    runs_last_14d: windowStats.runs_14d ?? 0,
    km_last_14d: Math.round((windowStats.km_14d ?? 0) / 10) / 100,
    is_longest_run_30d: longestIn30d.max_dist != null
      ? activity.distance >= longestIn30d.max_dist
      : true,
    is_longest_run_7d: longestIn7d.max_dist != null
      ? activity.distance >= longestIn7d.max_dist
      : true,
    longest_run_30d_km: longestIn30d.max_dist != null
      ? Math.round(longestIn30d.max_dist / 10) / 100
      : null,
    elevation_rank_30d: totalRunsIn30d.cnt > 0 ? elevRank.rank : null,
    moving_time_min: Math.round(activity.moving_time / 60),
    trimp_7d_total: trimp7d.total != null ? Math.round(trimp7d.total) : null,
    trimp_percentile_30d: trimpPercentile,
  };
}
```

**Step 3: Verify it compiles**

Run: `cd /Users/severi/code/personal/runnai && bun build src/index.ts --no-bundle 2>&1 | head -20`

**Step 4: Commit**

```bash
git add src/utils/activity-analysis.ts src/types/index.ts
git commit -m "feat: add computeTrainingContext for surrounding activity data"
```

---

### Task 3: Enrich `get_run_analysis` tool output with training context

**Files:**
- Modify: `src/tools/run-analysis.ts`

**Step 1: Import and call `computeTrainingContext`**

Add import at the top:
```typescript
import { computeTrainingContext } from "../utils/activity-analysis.js";
```

**Step 2: Add training context to the output object**

After the existing `stream_analysis` line (around line 93), add:

```typescript
const trainingContext = computeTrainingContext(activity_id, db);
```

And add to the `output` object:

```typescript
training_context: trainingContext,
```

**Step 3: Add `moving_time_min` to the existing output**

Currently missing from the output. Add to the `output` object:

```typescript
moving_time_min: Math.round(record.moving_time_s / 60),
```

**Step 4: Also include `lap_summaries` in the output**

Currently only `lap_count` is returned. The agent needs the actual lap data. Add:

```typescript
lap_summaries: record.lap_summaries,
```

**Step 5: Include existing analysis text if available**

Add to the output:

```typescript
detailed_analysis: record.detailed_analysis,
strava_title: record.strava_title,
strava_description: record.strava_description,
```

**Step 6: Verify it compiles**

Run: `cd /Users/severi/code/personal/runnai && bun build src/index.ts --no-bundle 2>&1 | head -20`

**Step 7: Commit**

```bash
git add src/tools/run-analysis.ts
git commit -m "feat: enrich get_run_analysis with training context and full data"
```

---

### Task 4: Add `save_run_analysis` tool

**Files:**
- Create: `src/tools/save-run-analysis.ts`
- Modify: `src/tools/index.ts` (add export)

**Step 1: Create the tool**

```typescript
import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { initDatabase } from "../utils/activities-db.js";

export const saveRunAnalysisTool = tool(
  "save_run_analysis",
  "Save a coaching analysis for a run. Stores the detailed analysis, Strava title, and Strava description in the database. Call this after analyzing a run to persist your analysis for future reference.",
  {
    activity_id: z.number().describe("Strava activity ID"),
    detailed_analysis: z.string().describe("Full coaching analysis (1-2 paragraphs)"),
    strava_title: z.string().optional().describe("Short activity title for Strava"),
    strava_description: z.string().optional().describe("Condensed coaching description for Strava (2-4 sentences)"),
  },
  async ({ activity_id, detailed_analysis, strava_title, strava_description }) => {
    try {
      const db = initDatabase();
      try {
        const now = new Date().toISOString();

        // Check activity exists in analysis table
        const existing = db.prepare(
          "SELECT activity_id FROM activity_analysis WHERE activity_id = ?"
        ).get(activity_id);

        if (!existing) {
          return {
            content: [{ type: "text" as const, text: `No analysis record for activity ${activity_id}. Run get_run_analysis first.` }],
            isError: true,
          };
        }

        db.prepare(`
          UPDATE activity_analysis
          SET detailed_analysis = ?, strava_title = ?, strava_description = ?, analysis_generated_at = ?
          WHERE activity_id = ?
        `).run(detailed_analysis, strava_title ?? null, strava_description ?? null, now, activity_id);

        return {
          content: [{ type: "text" as const, text: JSON.stringify({
            activity_id,
            saved: true,
            has_detailed_analysis: true,
            has_strava_title: !!strava_title,
            has_strava_description: !!strava_description,
            saved_at: now,
          }, null, 2) }],
        };
      } finally {
        db.close();
      }
    } catch (error) {
      return {
        content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  }
);
```

**Step 2: Export from `src/tools/index.ts`**

Add the export line:
```typescript
export { saveRunAnalysisTool } from "./save-run-analysis.js";
```

**Step 3: Register the tool in `src/index.ts`**

Find where tools are registered (look for `getRunAnalysisTool`) and add `saveRunAnalysisTool` next to it.

**Step 4: Verify it compiles**

Run: `cd /Users/severi/code/personal/runnai && bun build src/index.ts --no-bundle 2>&1 | head -20`

**Step 5: Commit**

```bash
git add src/tools/save-run-analysis.ts src/tools/index.ts src/index.ts
git commit -m "feat: add save_run_analysis tool for persisting agent analysis"
```

---

### Task 5: Remove sync-time prose generation

**Files:**
- Modify: `src/utils/activity-analysis.ts` (remove functions)

**Step 1: Delete dead code**

Remove these functions from `src/utils/activity-analysis.ts`:
- `buildProsePrompt()` (lines 249-376)
- `generateProseSummary()` (lines 383-407)
- `summarizeVerticalPhases()` (lines 409-431)
- `formatDuration()` (lines 433-438)

Also remove the `Anthropic` import at line 2 since it's only used by `generateProseSummary`.

**Keep** `formatPace()` — it's used by `get_run_analysis` tool.

**Step 2: Verify no remaining references**

Run: `cd /Users/severi/code/personal/runnai && grep -rn "buildProsePrompt\|generateProseSummary\|summarizeVerticalPhases" src/`
Expected: No results

**Step 3: Verify it compiles**

Run: `cd /Users/severi/code/personal/runnai && bun build src/index.ts --no-bundle 2>&1 | head -20`

**Step 4: Commit**

```bash
git add src/utils/activity-analysis.ts
git commit -m "refactor: remove sync-time prose generation (replaced by agent analysis)"
```

---

### Task 6: Rewrite strava-writeback skill

**Files:**
- Modify: `plugins/coach/skills/strava-writeback/SKILL.md`

**Step 1: Replace the entire SKILL.md with the new two-stage guidelines-based skill**

```markdown
---
name: strava-writeback
description: Analyze runs and write coaching insights back to Strava
---

# Strava Write-Back

## Flow

1. Call `get_run_analysis(activity_id)` to get all structured data and training context
2. Write a detailed coaching analysis (Stage 1)
3. Condense into a Strava title and description (Stage 2)
4. Show both the detailed analysis and Strava preview to the athlete
5. On approval, call `save_run_analysis` to persist, then `strava_update_activity` to write to Strava

## Stage 1: Detailed Coaching Analysis

Write 1-2 paragraphs analyzing the run like a coach reviewing the session file. Consider:

- **What the run actually was.** Don't just echo the classification. A 26km Z2 run is a significant aerobic session, not an "easy run." Consider the distance, duration, and terrain together.
- **Training load significance.** Use TRIMP and the training context (weekly volume, percentile vs 30 days, days since last run). Is this the biggest effort this week? A recovery day after a hard block?
- **Zone honesty.** Describe what happened on the course. If uphills pushed HR into Z3 for 15% of the run, that's terrain-driven intensity variation - don't flatten it to "comfortably in Z2." Break down climbs vs flats vs descents if the terrain shaped the effort.
- **Notable signals.** Cardiac drift, fatigue fade, pacing patterns, negative/positive splits, cadence changes. Only mention if they tell a coaching story.
- **Historical comparison.** Faster or slower than similar runs? Improving trend? Unusual?
- **Training plan context.** If the athlete has a plan, how does this session fit? Was it the intended workout?

Save the detailed analysis with `save_run_analysis`.

## Stage 2: Strava Title + Description

From the detailed analysis, distill:

### Title

Short and descriptive. No emoji, no stats, no plan references. Use regular hyphens (-), never em dashes.

Principles, not templates - develop your own natural titling voice. The title should capture the essence of what the session was. Some directions to consider:
- The primary training stimulus (distance, intensity, terrain)
- What made this session distinctive

### Description

Plain prose, 2-4 sentences. No headers, bullets, emoji, or stat lines. Use regular hyphens (-), never em dashes. This is what a coach would actually say about the session - coaching insight, not a data readback.

The description should surface the 1-3 most important observations from the detailed analysis. Not everything noteworthy goes into the Strava description - just the things a coach would want the athlete (and their friends who see it on Strava) to take away.

### What NOT to write

Never write descriptions like this:

```
26.2km @ 6:04/km | HR 148 avg | +305m elevation

Solid long run. 85% Z2, 15% Z3. Cardiac drift 3.2%. Even splits. TRIMP 180.
```

This is a data readback, not coaching insight.

## Safety

- NEVER delete or remove activities - only update name and description
- ALWAYS preview and get explicit confirmation before writing
- Attribution is appended automatically by the tool
```

**Step 2: Commit**

```bash
git add plugins/coach/skills/strava-writeback/SKILL.md
git commit -m "feat: rewrite strava-writeback skill as two-stage guidelines-based analysis"
```

---

### Task 7: Final verification

**Step 1: Full compile check**

Run: `cd /Users/severi/code/personal/runnai && bun build src/index.ts --no-bundle 2>&1 | head -30`
Expected: Clean build, no errors

**Step 2: Verify tool registration**

Run: `cd /Users/severi/code/personal/runnai && grep -n "saveRunAnalysis\|save_run_analysis\|save-run-analysis" src/index.ts src/tools/index.ts`
Expected: Tool exported and registered

**Step 3: Verify no dead references**

Run: `cd /Users/severi/code/personal/runnai && grep -rn "buildProsePrompt\|generateProseSummary\|prose_summary" src/ --include="*.ts" | grep -v node_modules | grep -v "\.d\.ts"`
Expected: Only the type definition in `types/index.ts` (kept for backward compat)

**Step 4: Commit any remaining fixes**
