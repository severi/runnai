---
name: strava-writeback
description: Analyze runs and write coaching insights back to Strava
---

# Strava Write-Back

## When this skill runs

The athlete just agreed to push an analysis to Strava. The analysis prose has already been written and (typically) saved via `save_run_analysis`. Your job is to compose a Strava title, get athlete approval on the package, run a review, and call `strava_update_activity`. Do NOT re-write the analysis from scratch unless the athlete asked for changes.

## Flow

1. **Fetch the saved analysis** if you don't already have it in this turn: call `get_run_analysis(activity_id)` and use `detailed_analysis` as the Strava description (verbatim). If the analysis isn't yet saved (rare — only if someone invoked this skill mid-analysis), write it per the New Run Analysis protocol first.
2. **Compose a Strava title** per the rules below.
3. **Preview only if something is new.** If the title is unchanged from the saved \`strava_title\` AND the description (= saved \`detailed_analysis\`) is unchanged since the athlete last saw it, skip the preview — the athlete already approved this content when they said "push to Strava". Go straight to step 4. **Only show a preview** when you're proposing a new/revised title or when the analysis was edited since the athlete last saw it. In that case: show the new title + note any changes to the description, ask in plain language (no structured AskUserQuestion). End the response. Wait for the next turn.
4. **On approval (next turn)**: dispatch the `analysis-reviewer` subagent via the Task tool with the title + description + activity_id.
   - Do NOT call save_run_analysis or strava_update_activity in the same response block as the Task result. Emit the review outcome first, THEN commit.
   - **No issues** → tell the athlete "✓ Review passed." Proceed.
   - **Critical findings** → revise, show the corrected preview, end response, wait for re-approval next turn.
   - **Important findings** → fix clear errors and mention; note any disagreement briefly.
   - One-shot per response: don't re-dispatch on a same-response revision.
5. **Persist any title revisions** by calling `save_run_analysis(activity_id, detailed_analysis, strava_title)` — this overwrites only the changed fields. Skip if title is unchanged from what's already saved.
6. **Push to Strava**: call `strava_update_activity(activity_id, name=strava_title, description=detailed_analysis)`. Pass the SAME prose that's in the saved `detailed_analysis` — the two must not diverge.

## Coaching Analysis

Write 1-2 paragraphs analyzing the run like a coach reviewing the session file. This analysis is used directly as the Strava description - no separate "condensed" version.

Consider:

- **What the run actually was.** Don't just echo the classification. A 26km Z2 run is a significant aerobic session, not an "easy run." Consider the distance, duration, and terrain together.
- **Training load significance.** Use TRIMP and the training context (weekly volume, percentile vs 30 days, days since last run). Is this the biggest effort this week? A recovery day after a hard block?
- **Zone honesty.** Describe what happened on the course. If uphills pushed HR into Z3 for 15% of the run, that's terrain-driven intensity variation - don't flatten it to "comfortably in Z2." Break down climbs vs flats vs descents if the terrain shaped the effort.
- **Notable signals.** Cardiac drift, fatigue fade, pacing patterns, negative/positive splits, cadence changes. Only mention if they tell a coaching story.
- **Historical comparison.** Faster or slower than similar runs? Improving trend? Unusual?
- **Training plan context.** If the athlete has a plan, how does this session fit? Was it the intended workout?

Plain prose, no headers, bullets, emoji, or stat lines. Use regular hyphens (-), never em dashes. Weave the data into the narrative rather than listing it.

Save the detailed analysis with `save_run_analysis`.

## Strava Title

Short and descriptive. No emoji, no stats, no plan references. Use regular hyphens (-), never em dashes.

Principles, not templates - develop your own natural titling voice. The title should capture the essence of what the session was. Some directions to consider:
- The primary training stimulus (distance, intensity, terrain)
- What made this session distinctive

## Safety

- NEVER delete or remove activities - only update name and description
- ALWAYS preview and get explicit confirmation before writing
- Attribution is appended automatically by the tool
