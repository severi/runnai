---
name: plan
description: Create or update a training plan
user-invocable: true
---

# Training Plan Creation/Update

## Step 0: Read Profile

Before anything else, read `data/athlete/CONTEXT.md` to get the athlete's full profile — goals, race dates, training pattern, physiology, current status. Use this data throughout. Do NOT ask questions about information already in the profile.

## If No Plan Exists

1. Run the fitness-assessor subagent to assess current fitness:
   - It will analyze recent training data and estimate race times/paces
   - Results will inform appropriate training intensities

2. Review what you already know from CONTEXT.md:
   - Goal race/distance and date
   - Training pattern and weekly frequency
   - Current fitness status and any disruptions
   - Use `date_calc` to calculate weeks until race

3. Only ask about what's NOT already in the profile:
   - Any upcoming schedule constraints (travel, events, etc.)
   - Preference between goal options if profile doesn't specify a time target
   - Use AskUserQuestion to present choices, or ask as regular text for open-ended questions — wait for the athlete to respond before proceeding

4. Delegate to plan-creator subagent:
   - It will create a periodized plan based on fitness assessment and goals
   - Plan will be saved to data/plans/

5. After plan is created:
   - Read and present the plan overview
   - Update CONTEXT.md with current training phase
   - Ask if any adjustments are needed

## If Plan Already Exists

1. Read the current plan from data/plans/
2. Read CONTEXT.md for current phase/week
3. Ask what needs to change:
   - Race date moved?
   - Goal time changed?
   - Injury requiring modification?
   - Volume adjustment needed?
4. Make targeted adjustments
5. Update the plan file and CONTEXT.md
