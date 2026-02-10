---
name: test-report-analysis
description: Extracts and stores physiological data from test reports (lactate tests, VO2max, metabolic panels, medical assessments)
---

# Test Report Analysis

When an athlete shares a test report (attached file or pasted data), follow this workflow to extract, store, and explain the results.

## Supported Report Types

- **Lactate threshold tests** — LT1/LT2 HR and pace, lactate curve
- **VO2max / metabolic tests** — VO2max, VT1/VT2, fat/carb oxidation rates, economy
- **Body composition** — weight, body fat %, lean mass
- **Blood panels** — ferritin, hemoglobin, vitamin D, thyroid markers
- **Medical assessments** — ECG findings, orthopedic evaluations
- **Other coaches' training plans** — extract structure, targets, philosophy

## Extraction Workflow

### 1. Identify what's in the report

Read the full document. Identify the test type, date performed, and lab/facility if mentioned.

### 2. Extract all physiological data present

Pull out every quantitative value you can find. Common metrics by test type:

**Lactate test:**
- HR at LT1 (aerobic threshold) and LT2 (anaerobic/lactate threshold)
- Pace or speed at LT1 and LT2
- Lactate values at each stage
- Max HR reached during test
- Recovery HR

**VO2max test:**
- VO2max (ml/kg/min)
- VT1 and VT2 (ventilatory thresholds) — HR, pace, VO2
- Running economy (ml O2/kg/km)
- Respiratory exchange ratio (RER) at key points
- Max HR
- Fat oxidation rate and FatMax zone

**Body composition:**
- Weight, body fat %, lean mass
- Bone density if available

**Blood work:**
- Ferritin, hemoglobin, hematocrit
- Vitamin D (25-OH)
- TSH, free T3/T4
- CRP, iron, B12, folate

### 3. Update HR zones if thresholds found

If the report contains LT1 HR, LT2 HR, or max HR, update the athlete's zones using the `set_hr_zones` tool:

- Zone 1 (Recovery): below LT1 - 10 bpm
- Zone 2 (Easy Aerobic): LT1 - 10 to LT1
- Zone 3 (Tempo): LT1 to LT2
- Zone 4 (Threshold): LT2 to LT2 + 5
- Zone 5 (VO2max): above LT2 + 5

These are starting points — adjust if the test provides explicit zone boundaries.

### 4. Update hot cache (CONTEXT.md)

Use `update_context` to refresh the Key Metrics section with the most coaching-relevant values:

- VO2max if tested
- LT2 HR and pace (threshold)
- Max HR if updated
- Current weight if significantly changed
- Any critical blood markers (e.g., low ferritin)

Keep it concise — only the values you'd reference in day-to-day coaching.

### 5. Write full results to deep memory

Use `write_memory` to save detailed results to `test-results.md`. Structure as:

```
## [Test Type] — [Date]
Facility: [if known]

### Results
[All extracted values in a readable table or list]

### Key Findings
[2-3 bullet summary of what matters for training]

### Previous Comparison
[If prior test data exists in memory, note changes]
```

Append to the file — don't overwrite previous test results. This creates a longitudinal record.

### 6. Explain to the athlete

After storing everything, explain the results in plain language:

- What the key numbers mean for their running
- How this compares to their previous data (check memory)
- What it implies for training zones and pacing
- Any concerns (e.g., low ferritin affecting performance)
- Specific training adjustments to consider

Avoid jargon. If the athlete asks technical questions, go deeper.

### 7. Suggest follow-up actions

- If zones changed: suggest running `strava_sync` to reclassify recent activities
- If plan adjustments needed: offer to update the training plan
- If blood markers are concerning: suggest following up with their doctor (never diagnose)
- If this is a first test: explain how future tests will track progress

## Important Notes

- **Never diagnose medical conditions.** Flag concerning values and recommend professional follow-up.
- **Check memory first.** Look for previous test results to provide trend analysis.
- **Date everything.** Tests are only meaningful with temporal context.
- **Preserve raw data.** Write the full extraction to memory even if only some values are immediately useful — future sessions may need the details.
