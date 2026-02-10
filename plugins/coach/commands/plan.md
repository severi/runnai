---
name: plan
description: Create or update a training plan
user-invocable: true
---

# Training Plan Creation/Update

## If No Plan Exists

1. First, run the fitness-assessor subagent to assess current fitness:
   - It will analyze recent training data and estimate race times/paces
   - Results will inform appropriate training intensities

2. Ask the athlete:
   - Confirm their goal race/distance and date (check CONTEXT.md first)
   - Use `date_calc` to calculate weeks until race
   - Any schedule constraints (days they can't run, travel, etc.)

3. Delegate to plan-creator subagent:
   - It will create a periodized plan based on fitness assessment and goals
   - Plan will be saved to data/plans/

4. After plan is created:
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
