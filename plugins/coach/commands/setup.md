---
name: setup
description: First-time onboarding - connect Strava, sync data, build athlete profile
user-invocable: true
---

# Onboarding Protocol

You are running the first-time setup for a new athlete. Complete ALL phases before finishing.

## Phase 1: Connect & Analyze
1. Connect Strava using `strava_auth` (skips automatically if already connected)
2. Fetch profile and sync using `strava_profile` with days=180 (skips sync if data is already up to date)
3. Call `best_efforts` (distance="all") for key performances. This is your ONLY source for performance data — do NOT derive best times from SQL queries. The tool returns lap data for each effort. Analyze the lap patterns to assess each effort:
   - **Warmup → even splits at high HR → cooldown** = dedicated time trial or race. High confidence this represents true capability.
   - **Fast segment embedded in a much longer run** (e.g., HM split from 31km run) = training effort. The athlete could likely run faster in a dedicated race.
   - **Variable pacing or fade at end** = not a controlled max effort.
   - **No lap data available** = effort predates detailed sync. Context is uncertain — note this.
   - **Official PRs** from `manage_personal_records` override GPS data.
4. Read `data/strava/recent-summary.md` to understand their training patterns
5. Query the database for training context — volume trends, run frequency, what kinds of runs they do, recent activity. IMPORTANT: Do NOT use `query_activities` to find best times — step 3 already has them. Start with the last 2 weeks, then zoom out. Current state matters most — when was the last run? Is there an ongoing gap right now? Don't get distracted by old anomalies that clearly resolved themselves (e.g., a gap from months ago followed by consistent training).
   Also search for fitness test or assessment activities by name (keywords like "test", "threshold", "lactate", "vo2max", "FTP", "time trial"). For each candidate, pull its lap data and verify it actually looks like a structured test — not just a workout that happens to contain the keyword. Only flag activities that genuinely look like formal assessments. These don't show up in best efforts for standard distances or in volume trends — but they're the most valuable data for calibrating zones and fitness estimates.

**Before presenting — pause and ask the athlete:**

Always ask:
- Have they done any formal fitness tests recently (lactate threshold, VO2max, etc.)? If you found test activities in step 5, reference them specifically — ask about results. If they have lab data, it overrides estimated HR zones and changes the entire training assessment.

Ask if the data warrants it:
- An ongoing training gap in the last 1-2 weeks → why? (injury, illness, taper)
- A sudden change in training pattern → intentional?
- Something unusual that can't be interpreted from data alone

Wait for their answer before presenting. Their response may change your analysis.

6. Do NOT present the training profile to the athlete until steps 1-5 are ALL complete. When presenting performances:
   - Always include the year and how long ago (e.g., "Dec 2025, ~10 weeks ago") — recency matters for whether a performance still reflects current fitness.
   - Use a compact table for the numbers, then short structured blocks for each assessment. Keep lines short — they wrap in the terminal. Do NOT write long paragraphs. Example format:
     ```
     | Distance | Time | Pace | When |
     |----------|------|------|------|
     | 5K | XX:XX | X:XX/km | Mon YYYY (~Xw ago) |

     **5K — XX:XX** (Mon YYYY, ~Xw ago)
     Dedicated time trial. Warmup → 4 even splits → cooldown. HR 189.
     Verdict: true best, high confidence.

     **10K — XX:XX** (Mon YYYY, ~Xw ago)
     From a 12km training run. Steady 4:30-4:50/km, HR 172.
     Verdict: probably not true max — likely faster in a dedicated race.
     ```

## Phase 2: Present & Start a conversation (wait for answer before continuing)
Present the analysis from Phase 1, then start a natural dialogue. Ask whatever feels relevant — could be one question, a few, or just a comment that invites a response. Some things worth paying attention to:
- What's happening right now (recent days/week) matters more than months ago
- Are they building toward something? Already following a plan?
- Is there something you can't figure out from data alone?
- If nothing stands out, simply asking about their goals or what brought them here is fine

## Phase 3: After user answers -> Goals & Concerns
1. Give a 1-2 sentence summary of their current training
2. Ask: "What's your primary running goal right now?"
3. When they mention a race: search for it with WebSearch to know the date, course, etc.
4. Ask: "Any current injuries, niggles, or limitations I should know about?"

## Phase 4: Save & Complete
1. Update CONTEXT.md with their profile using `update_context`:
   - Fill in all sections with real data
   - Include Strava-derived metrics (paces, volume, patterns)
   - In the best efforts / race history section, include your confidence assessment for each distance based on lap analysis (e.g., "5K: ~21:21 (dedicated time trial, high confidence)" or "10K: ~46:39 (from a 12km training run, probably not true best)")
   - Add their stated goals and concerns
2. Write initial observations to `write_memory` (observations.md):
   - Training patterns you noticed
   - Volume trends
   - Any anomalies discussed
3. Write to training-history.md:
   - Current training status and recent milestones
4. Tell them: "Profile saved! Here's what I know about you: [brief summary]. Use /plan to create a training plan, or just chat about your running."

CRITICAL: Do NOT respond with generic "how can I help" during onboarding. Complete all phases!
