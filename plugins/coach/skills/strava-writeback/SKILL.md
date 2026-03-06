---
name: strava-writeback
description: Write run analysis back to Strava with coaching-style names and descriptions
---

# Strava Write-Back

## Flow

1. For each activity, call `get_run_analysis(activity_id)` to get the full analysis data
2. Distill the data into a short name and plain prose description (see examples below)
3. Show preview to the athlete for approval
4. On approval, call `strava_update_activity` — attribution is appended automatically

## How to Write the Name

Short and descriptive. No emoji, no stats, no race countdowns. Use regular hyphens (-), never em dashes (—).

| Good | Bad |
|------|-----|
| Easy Long Run - Rolling Hills | 16km Easy Long \| Transition Week \| 6 weeks to Vienna |
| Tempo 8K | 40min tempo — Z3/Z4 threshold session |
| Recovery 6K | Easy Recovery Run (HR 132, Z1-Z2) |
| Hill Repeats - 1500m Vert | Mountain session — 20km vertical work |

## How to Write the Description

The description is the COMPLETE text - plain prose, no headers, no emoji, no stats lines, no bullet points. Use regular hyphens (-), never em dashes (—). It distills the analysis data into what a coach would actually say. These examples show the ENTIRE description, not excerpts:

### Example 1: Easy run

**Data:** 8.5km, 5:40/km, HR 136, Z1 40%, Z2 58%, Z3 2%, cardiac drift 2.8%, fatigue 0.3%

**Complete description:**
Easy midweek mileage with HR comfortably in Z1-Z2 throughout. Nothing to note - exactly what a recovery day should look like.

### Example 2: Tempo

**Data:** 12km, 4:45/km avg, laps: 2km warmup then 8km at 4:15-4:22, 2km cooldown. Z3 35%, Z4 55%, cardiac drift 6.2%, fatigue 7.1%

**Complete description:**
8km of threshold work at 4:18/km after a warm-up. Pacing was disciplined through 6km but the last two K drifted to 4:22 with HR climbing - the 7% fade suggests the effort was right at the limit. Good session to build from.

### Example 3: Hilly long run

**Data:** 18km, 8:30/km, GAP 5:50/km, +1200m gain, climbs avg HR 165 ~12:00/km, descents avg HR 140 ~5:30/km, cardiac drift 4.8%

**Complete description:**
18km in the hills with 1200m of climbing. The climbs pushed HR to 165 at hiking pace while descents provided active recovery at 140. Good cardiac drift control over 2.5 hours of sustained vertical work.

### What NOT to write

Never write descriptions like this:

```
8.5km @ 5:40/km | HR 136 avg | +45m elevation

Easy midweek run. 40% Z1, 58% Z2, 2% Z3. Cardiac drift 2.8% showing good coupling. TRIMP: 42. Even splits throughout. EF: 0.021.

Build week 3 continues tomorrow with tempo intervals.
```

This is a data readback, not a coaching insight. A coach would never talk like this.

## Safety

- NEVER delete or remove activities — only update name and description
- ALWAYS preview and get explicit confirmation before writing
