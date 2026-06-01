---
name: workout-analysis
description: Post-run assessment framework, effort evaluation, pace zone analysis, and training distribution
---

# Workout Analysis

## Two Artifacts, Not One

This skill is for the **coaching analysis** — the thorough private read for the athlete. Do not collapse it into a Strava description. The Strava description is a *separate* artifact, written later only when the athlete asks to push, by the strava-writeback skill, derived from but distinct from this analysis.

Coaching analysis is what the athlete consumes for actual coaching. It includes:
- Plan-vs-actual context
- Training-load significance (TRIMP, weekly load, percentile)
- Phase / lap / structure breakdown when the run had structure
- Derived metrics that disambiguate the story (efficiency factor, pace-CV, elevation-corrected pace, hr_trend pattern, fatigue index)
- Causal hypotheses with appropriate hedging
- Cross-run comparisons when they add value
- Mistakes / learnings
- What-to-do-next implications

Strava description (later, separate) is tight, public, what-happened-only. Plan / future / orthogonal content stays in the coaching analysis.

## Coaching Analysis Structure

This is the default depth. A one-paragraph summary is not a coaching analysis.

**Default sections** (omit any that don't apply, but make a deliberate choice — don't drop them by default):

1. **Plan-vs-actual** — what was scheduled, what got run, where they aligned/diverged. Lead with this on planned runs.
2. **Headline read** — one or two sentences capturing what the run actually was (not just classification — distance + intensity + terrain + context together).
3. **Phase / structure breakdown** — when the run had phases (warmup, work, cooldown), laps with elevation, climbs, intervals, pace shifts: walk through them. Don't average over a story.
4. **Derived metrics check** — go beyond avg pace + avg HR. Pull the metrics that disambiguate:
   - **Efficiency factor (NGP / avg HR)** when comparing runs at similar HR — this catches "felt stronger" / "felt fade" stories the averages hide.
   - **Pace coefficient of variation** across laps — high CV ≠ fade if it tracks elevation; low CV = clean rhythm.
   - **Elevation-corrected pace (GAP)** vs raw pace when terrain shaped the effort.
   - **hr_trend.pattern** (step_then_plateau / linear_drift / stable) — never characterize HR by endpoints alone.
   - **cardiac_drift_pct** with confound check — drift on a run with stops is an artifact, not a signal.
5. **Training-load context** — TRIMP, 7d distance, percentile vs 30 days, days since last run, where this sits in the week's plan. Without this, "easy 10K" reads the same regardless of whether it's run 1 or run 5 of a heavy week.
6. **Cross-run comparison** — when it adds coaching value (see triggers below).
7. **Causal hypotheses** — when the data shows a pattern (decoupling, fade, surge, drift), say what's likely happening and why, with hedging proportional to confound risk.
8. **Mistakes / learnings** — only if the data + context support them. Don't invent lessons.
9. **What-to-do-next** — implications for upcoming sessions when the run signals something the plan should respond to (rest, scale back, push). Skip when nothing actionable.

**Format for chat:** structured for readability. Headers (`##`), sub-points, tables when comparing — the athlete reads this directly, not on a public feed. Stat lines and tables ARE allowed (and often clearer than prose). Regular hyphens (-), never em dashes.

**Length:** as long as the run warrants. A clean honest Z2 with no signals = short. A daily double with cumulative load + a perceived bonk + plan implications = long. Don't pad, don't truncate.

## When to Add Cross-Run Comparison

Cross-run comparison is a capability you reach for when it adds coaching value, not a default step on every analysis.

**Reach for it when:**
- **Daily double / same-day pair** — morning vs afternoon. Often a "stronger second leg" or "fade in the second" story that EF + pace-CV reveal cleanly.
- **Same workout type recently repeated** — last week's tempo at the same target, last month's long run on the same route, the previous attempt at this hill session. Progression check.
- **Athlete reports a perceived difference** ("felt stronger today", "the second one felt heavier", "this was tougher than last time"). The data either backs the perception or contradicts it — both are useful.
- **Outlier signal vs the athlete's recent baseline** — a Z2 run at unusually low HR for the pace, a tempo with notably high drift, etc. The "vs baseline" is itself a comparison.
- **Plan-prescribed comparison** — back-to-back long runs (B2B), dress rehearsal vs race goal, etc.

**Don't force it when:**
- The run stands alone and tells a clear story on its own.
- The candidate "comparison run" was weeks ago and conditions / fitness have shifted.
- The comparison would just restate the per-run reads without new insight.

**How to do it:**
1. Pull the comparison run(s) via `query_activities` (recent runs of the same type / similar distance) or `get_run_analysis` (when you already know the activity_id).
2. Build a side-by-side: distance, pace, GAP, avg HR, cardiac drift, zone split, elevation gain, **efficiency factor**, pace-CV, weather. Tables work well here.
3. Identify what the numbers say vs the perception, especially when they diverge. The flip case ("athlete felt fade, EF says stronger") is one of the most coaching-valuable reads.
4. Say what the comparison means for training (fitness moving up, rhythm question, recovery question, etc.).

**Elevation gain — methodology gotcha:**
The `total_elevation_gain` field on the raw `activities` row comes from Strava's per-activity DEM smoothing, which varies in intensity per upload. Two runs on the *exact same route* can report different API values (we've seen 275m vs 376m for what was clearly the same loop). Do NOT use that field for cross-run comparison.
- For elevation in a comparison: read `elevation.gain_m` from `get_run_analysis` — that's the analyzer's stream-derived value (consistent algorithm across runs), or the raw field as a fallback when streams aren't available.
- When the athlete says "this is the same route as X," trust the route knowledge. If the elevation numbers disagree by >20%, that's almost certainly a Strava-smoothing artifact, not a real terrain difference. Don't build a story around the discrepancy.
- Altimeter readings also have ~5-10% noise across multi-month gaps (barometer drift, firmware changes). Small differences (<5%) between runs months apart are noise, not signal.

## Plan Comparison — Do This First

Before assessing effort quality, establish what the run was *supposed* to be:

1. **Check the plan context.** When analyzing new runs at session start, the startup prompt already pairs each run id with its planned session. If that pairing is present, use it directly. Otherwise call `get_plan_compliance` (omit `week_number` for the current week) — it returns each planned session joined to its matching actual run by date.
2. **Open the analysis with the plan reference.** Lead with what was planned: "You had **Tempo** scheduled today — 12km total: 2km WU → 30min @ 4:55–5:10/km → 2km CD."
3. **Assess execution against the plan, not against generic templates:**
   - Did the run match the session **type** (easy vs tempo vs long)?
   - For quality sessions: was the **intensity target** hit? Was the structure (warmup, work block, cooldown) executed correctly?
   - For easy runs: was it **genuinely easy** (Z1–Z2) as prescribed?
   - For long runs with MP segments: did the MP block hit the target window?
4. **Note deviations explicitly:**
   - If the planned distance/pace was missed by more than ~10%, call it out
   - If the run was a different type than planned (e.g., tempo done as easy, easy done at threshold), explain the gap
   - If the day was meant to be rest and a run happened anyway, flag it
5. **No plan match for this date?** Treat as unplanned — note it briefly and analyze on its own merits.

### Dates, Weekdays, and Run Counts — Never Eyeball These

Every weekday name, "run N of the week" count, and rest-day-vs-run-day claim MUST come from data, never from a plan row's position or your own mental calendar. This is a known failure mode — getting it wrong makes the entire analysis read as hallucinated even when the metrics are correct.

- **Weekday names come from the data, not the plan order.** `get_plan_compliance` returns `planned.weekday` and `actual.weekday` (e.g. "Saturday") for every entry — use those verbatim. The Nth row of a plan is NOT the Nth day of the week; plans get reshuffled (rest days inserted, days moved), so a run dated 2026-05-30 is a *Saturday* regardless of where it sits in the list. If you ever need a weekday for a date that isn't in the compliance output, call `date_calc` — never compute it in your head.
- **"Run N of the week" comes from `completedRunIndex`.** Each completed entry carries `completedRunIndex` (1-based, in true date order); `summary.completed` is the week's total. Cite "run 3 of 4 this week" only from those fields. Never count plan rows or list positions — a skipped session is still a row, so position ≠ run number.
- **Rest day vs run day comes from `actual`/`status`, not the plan.** A day is a run day only if an activity exists for it (`status: "completed"`). A planned session with `actual: null` and a past date is `missed` — do NOT narrate it as a completed run. A day with no plan row and no activity is simply a rest day; never invent a run for it.
- **Build the weekly summary table straight from the compliance entries.** One row per entry, weekday from `planned.weekday`, status from `status`. Do not assume a Monday-anchored Mon–Sun layout and back-fill weekday labels onto it.

### Annotating Completion in the Plan

**Timing:** annotate the plan exactly once per run. The trigger is the FIRST turn after posting the analysis where ANY of the following holds:

1. **Athlete acknowledges** ("looks good", "ok", "thanks", "ye", "yep")
2. **Athlete asks for Strava push** ("update strava", "push it", "post it") — annotate before invoking strava-writeback
3. **Athlete pivots to an unrelated topic** (asks about another run, asks a training question, asks about the plan, etc.) — treat as implicit acknowledgment of the analysis
4. **Athlete keeps iterating on the analysis itself** ("dig deeper", "redo", "compare to X", "what about Y") — DO NOT annotate yet; revise the analysis and wait for one of triggers 1-3

Don't annotate in the same turn as the initial draft. Don't annotate during a triage turn that ends with a clarifying question. Once annotated, don't re-annotate on subsequent revisions of the same run's analysis.

When the timing is right, update the plan row to mark the session as done:

- Call `manage_plan(action: "update")` with the full plan content (read it first)
- Add a brief outcome to the session cell of the matching row — keep the existing convention (e.g., `✅` followed by a one-line result)
- **Simple completion**: `✅ 12.1km @ 5:08/km, hit tempo target` — when the run matched the plan
- **Notable deviation**: include the key deviation: `✅ 8.2km tempo done at 4:55/km — 30% short on distance, dropped to a quality interval session`
- Do NOT rewrite other rows — preserve the rest of the plan exactly

This is how plan completion stays in the source of truth across sessions.

## Post-Run Assessment Framework

When analyzing a completed run, consider:

### 1. Was it the right effort?

**Always reference current pace zones from get_training_zones — not generic formulas, not the plan file's pace strings, not the lab test from months ago.** The plan file no longer hardcodes pace strings in workout cells; it says "Easy" and you resolve to the athlete's current easy range. If you're about to flag a run as "too fast for easy" based on a pace string somewhere, STOP and call get_training_zones first.

**Easy Run Assessment**:
- Pace should fall within the **current** easy range from get_training_zones (pace.easy)
- Heart rate should be in Zone 1-2 (between LT1 × 0.88 and LT1)
- HR is the ground truth: a run that looks "fast for easy" but had stable HR in Z2 with cardiac drift < 5% is NOT too hard — the zones may be stale, or the athlete may be fitter than the stored zones reflect. In that case, do not lecture on pace discipline. Trust the HR data and consider whether a fitness drift update is overdue.
- Common false alarm: flagging a run as "too fast for easy" based on stale stored paces when the training-data-derived current pace would put it squarely in Z2.

**Long Run Assessment**:
- First half should feel comfortable
- Pace within 30-60s/km of marathon pace is fine for experienced runners
- Negative split (second half faster) is ideal
- Watch for cardiac drift: HR increasing >10% at same pace indicates fatigue
- Fueling: runs over 90 minutes should include some nutrition

**Tempo/Threshold Assessment**:
- Pace should be sustainable for about 60 minutes in a race
- Heart rate in Zone 3-4
- "Comfortably hard" - can speak in short phrases but not sentences
- Consistent splits (less than 5s/km variation) = good execution

**Interval Assessment**:
- Target pace depends on interval length
- 400m-800m: ~5K pace or slightly faster
- 1000m-1600m: ~5K to 10K pace
- Recovery should be adequate (jog, not walk to a stop)
- Consistency across repeats more important than hitting one fast split
- Positive splits (slowing) across intervals suggests starting too fast

### 2. Training Load Indicators

**Acute Training Load (ATL)** - last 7 days:
- Sum of distance * intensity factor
- Easy run: 1.0x, Tempo: 1.5x, Intervals: 2.0x, Race: 2.5x

**Chronic Training Load (CTL)** - last 28 days rolling average:
- Fitness trends over time
- CTL going up = fitness building
- CTL going down = detraining or recovery

**Training Stress Balance (TSB)** = CTL - ATL:
- Positive: rested/fresh (good for racing)
- Negative: fatigued (building fitness)
- Very negative (<-20): risk of overtraining

### 3. Weekly Distribution

**80/20 Rule**: ~80% of running should be easy, ~20% moderate-to-hard

How to check:
- Count minutes at each intensity level
- Easy/recovery: Zone 1-2 HR or conversational pace
- Moderate: Zone 3 (tempo range)
- Hard: Zone 4-5 (intervals, races)

If more than 25% is moderate+hard, the athlete is likely doing too much intensity.

### 4. Key Metrics to Flag

**Cardiac Drift**:
- Compare HR in first 15 min vs last 15 min at same pace
- Drift >10%: dehydration, heat, or insufficient fitness
- Drift >15%: significant concern

**HR Trend Shape** (critical - avoid the endpoints-only fallacy):
- NEVER characterize HR by comparing only the first and last values of a segment
- Use the `hr_trend` field on work phases when available - it pre-computes the pattern
- **step_then_plateau**: HR rises in first 1-3km as body adjusts to the pace, then stabilizes. This is normal cardiovascular response, NOT drift. Describe as "HR settled at X after initial ramp-up" rather than "HR climbed from A to B"
- **linear_drift**: HR rises progressively throughout. This IS cardiac drift and worth flagging
- **stable**: HR stays consistent throughout - strong aerobic capacity signal
- Cross-check: if `cardiac_drift_pct` < 3%, a claim of "concerning HR rise" is almost certainly wrong. Re-examine the per-km data before making such a claim
- When in doubt, describe the actual shape ("rose for 2km then held steady at 167-170") rather than the delta ("rose 12 beats")

**Cadence**:
- Optimal: 170-185 spm for most runners
- Below 160: may indicate overstriding
- Cadence naturally increases with speed

**Pace Variability in Easy Runs**:
- High variability on flat terrain = inconsistent effort
- Suggest running by feel/HR rather than pace

**Elevation Impact**:
- Adjust pace expectations for hilly runs
- ~5-8s/km per 100m elevation gain is normal

## Feedback Guidelines

When giving feedback:
1. **Lead with the positive**: "Great consistency on those intervals"
2. **Be specific**: Reference actual paces, distances, dates
3. **Contextualize**: Compare to their typical performance, not abstract standards
4. **One key takeaway**: Don't overwhelm with 10 observations
5. **Actionable**: If something needs to change, say what and how
6. **Check memory**: Have they shown this pattern before? Reference it.

## Red Flags

- HR significantly higher than usual at same pace
- Pace dropping on easy runs (fatigue accumulation)
- Inability to hit interval targets they could hit 2 weeks ago
- Increasing RPE for same objective effort
- Missing workouts or cutting them short

## When to Ask Clarifying Questions

The data answers most questions. Only ask when subjective context would materially change your coaching interpretation — not to be thorough, not to seem engaged, not on every run.

### When to Ask

Ask when a signal is present but the cause is genuinely ambiguous:

- **Run classification is uncertain** and knowing the intended workout would change the coaching message (e.g., a borderline tempo/easy run calls for different advice depending on intent)
- **Cardiac drift is elevated for the context** — high drift on a short, cool run without an obvious load explanation usually means something the data can't see. Check weather first; if heat explains it, don't ask
- **Significant pace fade on a run that shouldn't have one** — fatigue index high on an easy or recovery run suggests something felt off (illness, poor sleep, accumulated fatigue)
- **Positive splits on a tempo or threshold run** — could be intentional pacing, conditions (wind, terrain), or going out too hard. The answer changes the feedback
- **Extended gap since last run** (7+ days) with no explanation in memory — the gap might be planned rest, travel, or a problem worth knowing about
- **Unusually high training load** relative to recent baseline on a run that wasn't a race or planned peak effort — the athlete may not realize how hard it registered
- **Linear HR drift on a long work phase** where cardiac drift is meaningfully elevated — hydration, heat, or fatigue context would shape the recommendation differently

### When NOT to Ask

- The data tells the full story (clean intervals with consistent splits, comfortable Z2 run with stable HR, long run that went as planned)
- You would ask only to confirm what you can already conclude
- The athlete just told you something that answers it
- The run was a race — the result is the context
- You already have the answer in memory — check before asking
- You've already asked about a different run in the same session and the current signal isn't more significant

### How to Ask

One question per run, plain prose. It should feel like a coach who reviewed the session file and wants to understand what they're seeing.

Good: "The drift suggests something was working against you in the second half — were you well-hydrated going in, or was it one of those days?"

Bad: "I have some questions: 1) How was hydration? 2) How was sleep? 3) Was this the intended effort?"

**Critical: the question must be the last thing in your response — no review, no save, no further tool calls after it.** The free-text question does not pause execution; the only way to actually wait for an answer is to stop emitting tools. The athlete's reply arrives as a new user turn; revise + review + save happen in that next turn. (See the "New Run Analysis" protocol in the system prompt for the exact flow.)

If you would not stop and wait for the answer, you are not actually asking a question — you are speculating in prose. Either commit to waiting (end response after the question) or don't ask.

### Using the Answer

The athlete's reply arrives in the next turn. Then:

1. **Acknowledge and update**: revise your interpretation where the answer changes it. A sentence of correction is enough — no full rewrite.
2. **Run the review step**: dispatch analysis-reviewer with the revised draft.
3. **Save**: call save_run_analysis(detailed_analysis=...) after review passes.
4. **Post the analysis in chat and stop.** Wait for the athlete's reaction before any Strava offer or further persistence.
5. **Pattern check**: if the answer reveals a recurring pattern (always drifts in afternoon runs, consistently pushes easy days too hard), save to memory with write_memory once the conversation settles.
6. **Strava description**: only when the athlete later asks to push. The strava-writeback skill produces a separate description from the saved coaching analysis.

### Multi-Run Batching

When several runs sync together (startup sync, or a weekly review), they are a **connected batch, not independent silos**. A short shakeout reads differently once you know a long run followed it the next day. Analyze them with mutual awareness:

**Process:**
1. **Gather all of them first.** Pull get_run_analysis (+ zones, plan compliance) for every run in the batch before drafting any read. You need the whole picture to place each run.
2. **Draft in chronological order (oldest first).** Each run's read should be aware of its siblings — the run(s) before it (cumulative load, recovery state, what it was recovering from) and the run(s) after it (what the day was setting up). Reference siblings by their verified weekday/date from plan compliance, never by guessed day.
3. **Give the reviewer the sibling context.** When you dispatch analysis-reviewer for a run whose draft references another run in the same batch ("the real volume came the next day", "the morning's shakeout"), include that sibling's key data (date, weekday, distance, pace, HR, type) in the reviewer's prompt. Otherwise the reviewer has no way to verify the reference and will (correctly, given its packet) flag it as unsupported. Cross-batch references are legitimate — make them verifiable.
4. **Add a batch synthesis** after the per-run reads when the runs form a related set — back-to-back days, a daily double, a weekend block, a same-week progression. Cover cumulative load across the batch and the through-line (e.g. "both weekend runs came in under your easy-pace floor with controlled HR"). This is a first-class part of a batch analysis, not an optional flourish — produce it unless the runs are genuinely unrelated (different types, no shared narrative), in which case say so briefly and skip it.
5. **Scope: the batch + normal recent context only.** Use the synced runs plus the recent training context the tools already surface (7d load, similar runs). Do NOT pull or re-analyze the wider history — this is a bounded recent batch, not a season review.

**Asking questions in a batch:**
- Don't ask per-run questions for every activity — that becomes an interview.
- Pick at most 1-2 runs with the most coaching-consequential ambiguity.
- If you ask, the question(s) are the last thing in the response — no reviews or saves happen this turn. The next turn (after the athlete answers) is where review + save run for all the analyzed drafts.
- If no run has a genuinely ambiguous signal, skip the follow-up entirely and proceed straight to per-run review + save in this turn.
