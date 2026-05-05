#!/usr/bin/env bun
import { migratePlans } from "../src/utils/migrate-plans.js";

const result = await migratePlans();
console.log(`Migrated: ${result.migrated.join(", ") || "(none)"}`);
console.log(`Skipped:  ${result.skipped.join(", ") || "(none)"}`);
