#!/usr/bin/env bun
/**
 * One-time script to save the 2026-02-10 marathon prediction to SQLite.
 * Run with: bun scripts/save-marathon-prediction.ts
 */
import { savePrediction } from "../src/utils/activities-db.js";

savePrediction({
  race_distance: "Marathon",
  predicted_time: 14280, // 3:58:00
  confidence: "medium",
  basis: "Weighted average of VDOT (5K 22:07, 10K 46:38, Half 1:54:41), Riegel formula, half doubling+first-marathon adjustment, long run pace extrapolation (31km@5:38/km), VO2max 53.6, 4-month improvement trend. Limiters: speed-biased profile (LT1 50%, LT2 74% VO2max), debut marathon.",
  predicted_at: "2026-02-10",
});

console.log("Saved marathon prediction: 3:58:00 (14280s), medium confidence");
