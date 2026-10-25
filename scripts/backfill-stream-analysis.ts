#!/usr/bin/env bun
/**
 * Compute stream analysis (NGP, efficiency factor, drift, phases) for every run
 * that has streams but no current-version analysis row. Safe to re-run; writes
 * only activity_stream_analysis. Also applies title-based auto tags (stroller
 * etc.) to every run, so the aerobic-trend cohort can exclude them.
 *
 * Run with: bun scripts/backfill-stream-analysis.ts [limit]
 */
import { backfillStreamAnalysis, countRunsMissingStreamAnalysis } from "../src/utils/stream-backfill.js";
import { getDb, autoTagActivity } from "../src/utils/activities-db.js";

const limit = Number(process.argv[2] ?? 5000);

const before = countRunsMissingStreamAnalysis();
console.log(`Runs missing stream analysis: ${before}`);
const started = Date.now();
const result = await backfillStreamAnalysis(limit);
console.log(`Computed ${result.computed}, skipped ${result.skipped}, remaining ${result.remaining} in ${((Date.now() - started) / 1000).toFixed(1)}s`);

// Title/description only. The coach's saved prose was tried and rejected: a
// tempo read that cites "your stroller history" is not a stroller run.
const runs = getDb().prepare("SELECT id, name, description FROM activities WHERE type = 'Run'")
  .all() as { id: number; name: string | null; description: string | null }[];
let tagged = 0;
for (const r of runs) {
  if (autoTagActivity(r.id, r.name, r.description).length) tagged++;
}
console.log(`Auto-tagged ${tagged} run(s) from title/description.`);
