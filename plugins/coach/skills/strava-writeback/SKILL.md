---
name: strava-writeback
description: Derive a public Strava description from the saved coaching analysis, then push to Strava
---

# Strava Write-Back

## When this skill runs

The athlete has explicitly asked to push to Strava ("update strava", "push it", "post it"). The thorough **coaching analysis** has already been written, reviewed, saved to `detailed_analysis`, and the athlete has signaled they're aligned on it. Your job now is:

1. Derive a *separate* Strava description from the saved coaching analysis.
2. Compose a Strava title.
3. Preview both, get explicit approval.
4. Run a Strava-mode reviewer pass.
5. Save and push.

**The Strava description is NOT a copy of `detailed_analysis`.** Verbatim copy is the wrong move — the coaching analysis is structured, plan-aware, and full of context the public feed shouldn't see. The Strava description is a tight derivative.

## Flow

1. **Load the source.** Call `get_run_analysis(activity_id)` to fetch the saved `detailed_analysis`. This is the source material.
   - **Empty source**: If `detailed_analysis` is empty, do not proceed; ask the athlete whether to run the analysis first.
   - **Legacy / Strava-shaped source**: rows from before the analysis-vs-Strava split (pre-2026-05-07) have `detailed_analysis` written under the old constraints — short, no headers, no plan / training-load / what-to-do-next sections, often identical to `strava_description`. Detect this: if the saved `detailed_analysis` is < ~200 words AND has no headers / sub-points AND lacks plan context AND lacks training-load context, treat it as legacy. Don't derive a Strava description from it (you'd be deriving from a derivative). Instead, briefly tell the athlete the saved analysis predates the new format and run the full **New Run Analysis** flow (Phase 1) to produce a proper coaching analysis first, then return here for the Strava push.

2. **Derive the Strava description.** Read the coaching analysis and write a *new* 1-2 paragraph public-feed version. See the description guide below for what to include and exclude.

3. **Compose a Strava title** per the title rules below.

4. **Preview before pushing.** Show the proposed title and the full description verbatim — exactly as it will appear on Strava (attribution is appended by the tool, no need to include). Use this format:

   ```
   **Title:** <proposed title>

   **Description:**
   <full description verbatim>
   ```

   Then ask in plain prose: "push this to Strava? or want to tweak?" End the response. Wait for the next turn. **Never call `strava_update_activity` without showing the exact title + description in the immediately preceding response.** No exceptions for "the description hasn't changed since last turn" — the athlete wants to see what's about to be posted, every time.

5. **On approval (next turn)**: dispatch the `analysis-reviewer` subagent via the Task tool with the title + description + activity_id, with mode set to `strava` so the reviewer applies public-feed constraints (no plan refs, no leaked chat, no causal claims without support, no orthogonal topics, no em dashes, no stat dumps).
   - Do NOT call save_run_analysis or strava_update_activity in the same response block as the Task result. Emit the review outcome first, THEN commit.
   - **No issues** → tell the athlete "✓ Review passed." Proceed.
   - **Critical findings** → revise, show the corrected preview (title + description block), end response, wait for re-approval next turn.
   - **Important findings** → fix clear errors and mention; note any disagreement briefly.
   - One-shot per response: don't re-dispatch on a same-response revision.

6. **Persist** by calling `save_run_analysis(activity_id, strava_title=..., strava_description=...)`. This writes ONLY the Strava fields; do not pass `detailed_analysis` (it's already saved and the athlete has aligned on it).

7. **Push to Strava**: call `strava_update_activity(activity_id, name=strava_title, description=strava_description)`. Pass the SAME prose that you just saved as `strava_description` — those two must not diverge.

## Strava Description Guide

The description is what people see on a public Strava feed. It's a tight account of this run, not a coaching report. Write 1-2 paragraphs of plain prose; no headers, bullets, emoji, or stat lines. Regular hyphens (-), never em dashes.

### What goes in

- **What the run actually was.** Don't just echo the classification. A 26km Z2 run is a significant aerobic session, not an "easy run." Consider distance, duration, terrain together.
- **Zone honesty.** What happened on the course. If uphills pushed HR into Z3 for 15% of the run, that's terrain-driven intensity — say so. Break down climbs vs flats vs descents if terrain shaped the effort.
- **Notable signals.** Cardiac drift, fade, pacing patterns, negative/positive splits, cadence — only if they tell a clean story for a public reader.
- **Brief historical comparison if striking** (faster than usual, longest in months) — keep it data-only, no plan framing.
- **Conditions** if they're in the activity data AND shaped the effort (heat, wind, terrain).

### What stays out (these belong in the coaching analysis, not here)

- **Plan-vs-actual framing.** No "Planned: X. Actual: Y", no "Week 9 hill repeats per the plan", no plan week numbers.
- **Future training.** No "tomorrow's session", "rest of the week", "next week's long run".
- **Orthogonal training topics.** Zone-recalibration, race-goal speculation, supercompensation, "post-marathon legs", weekly load percentile — those belong in chat / coaching analysis.
- **Conversational artifacts.** No "your read is right", "as you mentioned", "you nailed it".
- **Leaked chat details.** Photos, family trips, store stops, gear choices, nutrition specifics, why the athlete was running late — exclude unless directly material to the data.
- **Unwarranted causal claims.** Don't attribute the effort to fatigue/heat/legs unless the athlete said so or the data is unambiguous. Hedge or omit.
- **Trivial lesson lists.** "Breakfast was too much, shoes too tight, fueling worked" — drop or compress to one terse line if truly relevant.
- **Mistakes / learnings sections.** Coaching content. Stays in `detailed_analysis`.
- **What-to-do-next sections.** Coaching content. Stays in `detailed_analysis`.
- **Internal-only metrics.** TRIMP percentile, 7d distance, cumulative weekly load — fine in coaching analysis, skip on the feed.
- **Awkward literary framing.** "The race came in two halves that belong to different stories", "the legs told a different story" — write plainly.

### Length

Most Strava descriptions land at 80-180 words. Long enough to capture what happened, short enough that a feed reader gets the gist quickly. If the coaching analysis was 600 words, the Strava description should be roughly 100-150.

## Strava Title

Short and descriptive. No emoji, no stats, no plan references. Regular hyphens (-), never em dashes.

Principles, not templates — develop a natural titling voice that captures the essence of the session. Some directions:
- The primary training stimulus (distance, intensity, terrain)
- What made this session distinctive

## Safety

- NEVER delete or remove activities — only update name and description
- ALWAYS show the title + description preview block before calling `strava_update_activity`, even if the content hasn't changed since last turn
- The Strava description must be a *derivative* of the saved `detailed_analysis`, not a clone — apply the constraints above
- Attribution is appended automatically by the tool
