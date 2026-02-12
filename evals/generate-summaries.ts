/**
 * Generates recent-summary.md and training-patterns.md for each fixture.
 * Run: bun evals/generate-summaries.ts
 */
import path from "path";
import { generateRecentSummary } from "../src/utils/recent-summary.js";
import { generateTrainingPatterns } from "../src/utils/training-patterns.js";

const EVALS_DIR = import.meta.dir;
const FIXTURES = ["new-runner", "experienced-marathoner", "comeback-runner"];

for (const fixture of FIXTURES) {
  const fixtureDir = path.join(EVALS_DIR, "fixtures", fixture);
  process.env.RUNNAI_DATA_DIR = fixtureDir;

  console.log(`\n=== ${fixture} ===`);

  try {
    const summary = await generateRecentSummary();
    console.log(`  recent-summary.md: ${summary.split("\n").length} lines`);
  } catch (e: any) {
    console.error(`  recent-summary.md FAILED: ${e.message}`);
  }

  try {
    await generateTrainingPatterns();
    console.log(`  training-patterns.md: OK`);
  } catch (e: any) {
    console.error(`  training-patterns.md FAILED: ${e.message}`);
  }
}

console.log("\nDone.");
