---
name: workout-analysis
description: Post-run assessment framework, effort evaluation, pace zone analysis, and training distribution
---

# Workout Analysis

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

### Annotating Completion in the Plan

**Timing:** annotate the plan only AFTER the analysis-reviewer has passed (or its findings have been addressed) and `save_run_analysis` has run. Per the New Run Analysis protocol, this happens right after step 5 (save) and before the Strava offer. **Never** annotate before the reviewer runs — the annotation captures the final analysis, not the draft. **Never** annotate during a triage turn that ends with a clarifying question — defer to the next turn after the athlete answers.

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

1. **Acknowledge and update**: revise your interpretation where the answer changes it. A sentence of correction is enough — no full rewrite
2. **Run the review step**: dispatch analysis-reviewer with the revised draft (per protocol step 6)
3. **Save**: call save_run_analysis after review passes (per protocol step 7)
4. **Pattern check**: if the answer reveals a recurring pattern (always drifts in afternoon runs, consistently pushes easy days too hard), save to memory with write_memory
5. **Strava description**: if writing back to Strava, incorporate the context naturally — "the HR drift likely reflects a short night rather than a fitness concern"

### Multi-Run Batching

When analyzing several runs at once (startup sync, weekly review):

- Don't ask per-run questions for every activity — that becomes an interview
- Pick at most 1-2 runs with the most coaching-consequential ambiguity
- If you ask, the question(s) are the last thing in the response — no reviews or saves happen this turn. The next turn (after the athlete answers) is where review + save run for all the analyzed drafts.
- If no run has a genuinely ambiguous signal, skip the follow-up entirely and proceed straight to per-run review + save in this turn.
