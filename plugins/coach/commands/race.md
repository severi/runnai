---
name: race
description: Race time prediction with historical trend tracking
user-invocable: true
---

# Race Prediction

1. Check CONTEXT.md for the athlete's goal race and distance

2. Delegate to fitness-assessor subagent:
   - Analyze recent 6-8 weeks of training data
   - Estimate race times using pace equivalence tables
   - Consider training volume, quality sessions, and any recent races

3. Get prediction history:
   - Use `get_prediction_history` to see how predictions have evolved
   - Show the trend: "Your predicted marathon time has improved from 3:45 to 3:38 over the last 6 weeks"

4. Save the new prediction:
   - Use `save_race_prediction` with the estimated time, confidence level, and basis

5. Present the analysis:
   - Current prediction with confidence level
   - How it compares to previous predictions (trend)
   - What's driving the estimate (which training data)
   - What could improve the prediction (more data, specific workouts, etc.)

6. If a race date is set:
   - Use `date_calc` to show weeks remaining
   - Assessment of whether the goal is realistic given current trajectory
   - Recommendations for remaining training
