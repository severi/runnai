/**
 * Custom Promptfoo provider — thin JS wrapper that spawns bun for each eval.
 *
 * Node.js can't handle our bun:sqlite imports, so we delegate the actual
 * agent execution to a bun subprocess via run-agent.ts.
 */
import { execFileSync } from "child_process";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const AGENT_SCRIPT = resolve(__dirname, "run-agent.ts");

export default class RunnAIProvider {
  constructor(options) {
    this.config = options.config || {};
    this.providerId = options.id || "runnai";
  }

  id() {
    return this.providerId;
  }

  async callApi(prompt, context) {
    const fixture = context?.vars?.fixture || "new-runner";
    const model = this.config.model || "sonnet";
    const fixtureDir = resolve(__dirname, "fixtures", fixture);

    try {
      const result = execFileSync("bun", ["run", AGENT_SCRIPT], {
        env: {
          ...process.env,
          RUNNAI_DATA_DIR: fixtureDir,
          RUNNAI_EVAL_MODEL: model,
          RUNNAI_EVAL_PROMPT: prompt,
        },
        encoding: "utf-8",
        timeout: 180000, // 3 min per eval
        maxBuffer: 10 * 1024 * 1024, // 10 MB
      });

      // The script outputs JSON with { output, toolCalls }
      const parsed = JSON.parse(result.trim());

      return {
        output: parsed.output,
        metadata: {
          fixture,
          model,
          toolCalls: parsed.toolCalls,
        },
      };
    } catch (error) {
      const stderr = error.stderr?.toString() || "";
      const stdout = error.stdout?.toString() || "";
      return {
        output: stdout || "",
        error: `Agent execution failed: ${error.message}\n${stderr}`,
      };
    }
  }
}
