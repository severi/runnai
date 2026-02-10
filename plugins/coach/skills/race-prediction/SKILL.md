---
name: race-prediction
description: Race time estimation using VDOT, Riegel formula, training-based methods, and prediction tracking
---

# Race Prediction

## Estimation Methods

### 1. From Recent Race Results (Most Accurate)
Use equivalence tables to predict other distances from a known race time.

**Riegel Formula**: T2 = T1 * (D2/D1)^1.06
- More accurate for similar distances
- Overestimates for much longer distances (fatigue factor)

**Common Conversions**:
| From | To Marathon | Multiplier |
|------|-----------|------------|
| 5K | Marathon | ~9.8-10.2x |
| 10K | Marathon | ~4.6-4.8x |
| Half | Marathon | ~2.08-2.15x |

**Examples**:
- 20:00 5K -> ~3:16-3:24 Marathon
- 45:00 10K -> ~3:27-3:36 Marathon
- 1:35 Half -> ~3:18-3:25 Marathon

### 2. From Training Data (When No Recent Races)

**From Threshold Pace**:
- Threshold pace (tempo run pace) ~ half marathon race pace
- Marathon pace ~ threshold + 15-25s/km
- Use: recent tempo/threshold workout paces

**From Long Run Pace**:
- Long run easy pace is typically 1:00-1:30/km slower than marathon pace
- If long runs averaging 6:00/km -> marathon pace ~4:45-5:00/km

**From Easy Run Pace**:
- Easy pace is typically 1:30-2:00/km slower than threshold
- Less reliable but useful as a sanity check

### 3. VDOT-Based Estimation

VDOT is a single number representing running fitness. Key reference points:

| VDOT | 5K | 10K | Half | Marathon |
|------|-----|------|------|----------|
| 30 | 32:11 | 1:06:48 | 2:27:47 | 5:09:18 |
| 35 | 27:00 | 55:55 | 2:03:28 | 4:17:32 |
| 40 | 23:09 | 47:56 | 1:45:36 | 3:40:13 |
| 45 | 20:13 | 41:50 | 1:32:09 | 3:12:17 |
| 50 | 17:54 | 37:02 | 1:21:33 | 2:50:47 |
| 55 | 16:03 | 33:12 | 1:13:03 | 2:33:33 |
| 60 | 14:30 | 30:00 | 1:05:56 | 2:19:07 |

## Confidence Levels

### High Confidence
- Based on a race within last 6 weeks at a similar distance
- Training data is consistent and extensive (8+ weeks)
- Athlete has run the predicted distance before

### Medium Confidence
- Based on training paces only (no recent race)
- Race was >6 weeks ago
- Predicting a distance the athlete hasn't raced

### Low Confidence
- Limited training data (<4 weeks)
- Predicting from a very different distance (5K -> ultra)
- Significant fitness changes expected before race
- First-time at the distance

## Environmental Adjustments

### Heat
- +5-10s/km for temperatures above 15C
- +15-30s/km for temperatures above 25C
- Humidity amplifies the effect

### Altitude
- +3-5% time for every 1000m above sea level
- Acclimatization takes 2-3 weeks

### Terrain
- Trail races: add 20-50% to road time depending on technicality
- Hilly courses: roughly +1s/km per 10m elevation gain per km

### Wind
- Headwind costs more than tailwind saves (net negative for out-and-back)
- Strong headwind can add 10-30s/km

## Tracking Prediction Evolution

When saving predictions:
1. Always record the basis (what data drove the estimate)
2. Record confidence level
3. Use `save_race_prediction` to persist to SQLite
4. Use `get_prediction_history` to show trends
5. Compare predictions over time: are they improving, plateauing, or declining?

Prediction trends inform coaching:
- **Improving**: Training is working, stay the course
- **Plateauing**: May need stimulus change (new workout types, more volume)
- **Declining**: Check for overtraining, life stress, injury
