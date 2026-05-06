---
name: strava-writeback
description: Analyze runs and write coaching insights back to Strava
---

# Strava Write-Back

## When this skill runs

The athlete just agreed to push an analysis to Strava. The analysis prose has already been written and (typically) saved via `save_run_analysis`. Your job is to compose a Strava title, **always show the exact title + description as a preview**, get explicit approval, run the reviewer, and call `strava_update_activity`. Do NOT re-write the analysis from scratch unless the athlete asked for changes.

## Flow

1. **Fetch the saved analysis** if you don't already have it in this turn: call `get_run_analysis(activity_id)` and use `detailed_analysis` as the Strava description (verbatim). If the analysis isn't yet saved (rare — only if someone invoked this skill mid-analysis), write it per the New Run Analysis protocol first.
2. **Compose a Strava title** per the rules below.
3. **Always preview before pushing.** Show the proposed title and the full description verbatim — exactly as it will appear on Strava (attribution is appended by the tool, no need to include). Use this format:

   ```
   **Title:** <proposed title>

   **Description:**
   <full description verbatim>
   ```

   Then ask in plain prose: "push this to Strava? or want to tweak?" End the response. Wait for the next turn. **Never call `strava_update_activity` without showing the exact title + description in the immediately preceding response.** No exceptions for "the description hasn't changed since last turn" — the athlete wants to see what's about to be posted, every time.
4. **On approval (next turn)**: dispatch the `analysis-reviewer` subagent via the Task tool with the title + description + activity_id.
   - Do NOT call save_run_analysis or strava_update_activity in the same response block as the Task result. Emit the review outcome first, THEN commit.
   - **No issues** → tell the athlete "✓ Review passed." Proceed.
   - **Critical findings** → revise, show the corrected preview (title + description block), end response, wait for re-approval next turn.
   - **Important findings** → fix clear errors and mention; note any disagreement briefly.
   - One-shot per response: don't re-dispatch on a same-response revision.
5. **Persist any title revisions** by calling `save_run_analysis(activity_id, detailed_analysis, strava_title)` — this overwrites only the changed fields. Skip if title is unchanged from what's already saved.
6. **Push to Strava**: call `strava_update_activity(activity_id, name=strava_title, description=detailed_analysis)`. Pass the SAME prose that's in the saved `detailed_analysis` — the two must not diverge.

## Coaching Analysis (the description)

The description is what people see on a public Strava feed. It's a tight account of this run, not a coaching report. Write 1-2 paragraphs of plain prose; no headers, bullets, emoji, or stat lines. Regular hyphens (-), never em dashes.

### What goes in

- **What the run actually was.** Don't just echo the classification. A 26km Z2 run is a significant aerobic session, not an "easy run." Consider distance, duration, terrain together.
- **Training load significance.** TRIMP, weekly volume, percentile vs 30 days, days since last run. Is this the biggest effort this week? A recovery day after a hard block?
- **Zone honesty.** What happened on the course. If uphills pushed HR into Z3 for 15% of the run, that's terrain-driven intensity — say so. Break down climbs vs flats vs descents if terrain shaped the effort.
- **Notable signals.** Cardiac drift, fatigue fade, pacing patterns, negative/positive splits, cadence changes — only if they tell a coaching story.
- **Historical comparison if striking.** Faster/slower than similar runs? Improving trend?

### What stays out

These are recurring edits the athlete makes — bake them in at draft time:

- **Plan-vs-actual framing.** No "Planned: X. Actual: Y", no "Week 9 hill repeats per the plan". Describe the run on its own terms.
- **Future training.** No "tomorrow's session", "rest of the week", "next week's long run". This run only.
- **Orthogonal training topics.** No zone-recalibration debates, race-goal speculation, supercompensation theories, "post-marathon legs". Those belong in chat, not on the feed.
- **Conversational artifacts.** No "your read is right", "as you mentioned", "you nailed it". The description is not a reply to the athlete.
- **Leaked chat details.** Photos, family trips, store stops, gear choices, nutrition specifics, why the athlete was running late — exclude unless directly material to the run's data signals.
- **Unwarranted causal claims.** Don't attribute the effort to fatigue/heat/legs/whatever unless the athlete said so or the data is unambiguous. Hedge or omit.
- **Trivial lesson lists.** "Breakfast was too much, shoes too tight, fueling worked, gels every 20 minutes" — drop or compress to one terse line if truly relevant.
- **Unverified weather/conditions.** Only mention weather if it's in the activity data AND shaped the effort. Don't invent wind speeds or temperatures.
- **Awkward literary framing.** "The race came in two halves that belong to different stories", "the legs told a different story" — write plainly, not novelistically.

## Strava Title

Short and descriptive. No emoji, no stats, no plan references. Regular hyphens (-), never em dashes.

Principles, not templates — develop a natural titling voice that captures the essence of the session. Some directions:
- The primary training stimulus (distance, intensity, terrain)
- What made this session distinctive

## Safety

- NEVER delete or remove activities — only update name and description
- ALWAYS show the title + description preview block before calling `strava_update_activity`, even if the content hasn't changed since last turn
- Attribution is appended automatically by the tool
