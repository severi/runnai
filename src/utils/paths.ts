import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(__dirname, "../..");

/**
 * Returns the data directory path. Uses RUNNAI_DATA_DIR env var if set,
 * otherwise defaults to <PROJECT_ROOT>/data/.
 *
 * This allows evals to point the agent at fixture data directories.
 */
export function getDataDir(): string {
  return process.env.RUNNAI_DATA_DIR || path.join(PROJECT_ROOT, "data");
}
