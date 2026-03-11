---
name: strava-writeback
description: Analyze runs and write coaching insights back to Strava
---

# Strava Write-Back

## Flow

1. Call `get_run_analysis(activity_id)` to get all structured data and training context
2. Write the coaching analysis
3. Pick a Strava title
4. Show the title + analysis to the athlete as the Strava preview
5. On approval, call `save_run_analysis` to persist, then `strava_update_activity` to write to Strava

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
