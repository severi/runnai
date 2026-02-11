---
name: setup
description: First-time onboarding - connect Strava, sync data, build athlete profile
user-invocable: true
---

# Onboarding Protocol

You are running the first-time setup for a new athlete. Complete ALL phases before finishing.

## Phase 1: Connect & Analyze
1. Connect Strava using `strava_auth`
2. Fetch profile and sync 180 days of data using `strava_profile` with days=180 (this also fetches best efforts and laps from Strava)
3. Read `data/strava/recent-summary.md` to understand their training patterns
4. Query the database for training volume:
   - Weekly volume trend (last 12 weeks)
   - Longest runs
5. Use the `best_efforts` tool (distance="all") for key performances — do NOT compute best times from raw SQL queries. The best_efforts tool provides Strava's accurate best effort times and shows effort context (race vs training). Pay attention to:
   - **effortContext**: "race" efforts are actual race performances. "training_embedded" efforts (e.g., a HM from a 31km run) are NOT race efforts and may be much slower than what the athlete could actually race.
   - **Official PRs**: If declared PRs exist, they override GPS data.
   - When presenting performances, always note which were actual races vs training efforts — the athlete will want to know you understand the difference.

## Phase 2: Clarify Training (ONE question, wait for answer)
1. Find the biggest anomaly or interesting pattern in their data
2. Ask ONE specific question with actual numbers:
   - Example: "You went from 70km/week to 20km in mid-November. What happened?"
   - Example: "Your long runs are consistently 25km+. Are you training for an ultra?"
   - Example: "You've been averaging 40km/week for 3 months. Looking to build from there?"

## Phase 3: After user answers -> Goals & Concerns
1. Give a 1-2 sentence summary of their current training
2. Ask: "What's your primary running goal right now?"
3. When they mention a race: search for it with WebSearch to know the date, course, etc.
4. Ask: "Any current injuries, niggles, or limitations I should know about?"

## Phase 4: Save & Complete
1. Update CONTEXT.md with their profile using `update_context`:
   - Fill in all sections with real data
   - Include Strava-derived metrics (paces, volume, patterns)
   - Add their stated goals and concerns
2. Write initial observations to `write_memory` (observations.md):
   - Training patterns you noticed
   - Volume trends
   - Any anomalies discussed
3. Write to training-history.md:
   - Current training status and recent milestones
4. Tell them: "Profile saved! Here's what I know about you: [brief summary]. Use /plan to create a training plan, or just chat about your running."

CRITICAL: Do NOT respond with generic "how can I help" during onboarding. Complete all phases!
