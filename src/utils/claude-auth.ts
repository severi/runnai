import { execFile } from "child_process";

export interface ClaudeAuthStatus {
  loggedIn: boolean;
  email?: string;
}

// `claude auth status` prints a JSON object, possibly surrounded by other
// output (update notices, etc.) — extract from the first `{` onward.
export function parseAuthStatus(stdout: string): ClaudeAuthStatus | null {
  const start = stdout.indexOf("{");
  if (start === -1) return null;
  try {
    const parsed = JSON.parse(stdout.slice(start)) as Record<string, unknown>;
    if (typeof parsed.loggedIn !== "boolean") return null;
    return {
      loggedIn: parsed.loggedIn,
      email: typeof parsed.email === "string" ? parsed.email : undefined,
    };
  } catch {
    return null;
  }
}

export function extractLoginUrl(text: string): string | null {
  const match = text.match(/https:\/\/\S+/);
  if (!match) return null;
  return match[0].replace(/[.,)\]'"]+$/, "");
}

/**
 * Query `claude auth status`. Resolves null if the binary is missing, times
 * out, or prints something unparseable — never throws. Parses stdout even on
 * non-zero exit (logged-out status may exit non-zero).
 */
export function getAuthStatus(): Promise<ClaudeAuthStatus | null> {
  return new Promise((resolve) => {
    execFile("claude", ["auth", "status"], { timeout: 10_000 }, (_err, stdout) => {
      resolve(parseAuthStatus(String(stdout ?? "")));
    });
  });
}
