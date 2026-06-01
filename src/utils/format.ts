/** Format seconds as H:MM:SS or M:SS */
export function formatTime(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.round(seconds % 60);

  if (hours > 0) {
    return `${hours}:${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
  }
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

/** Format pace as M:SS from sec/km (no suffix) */
export function formatPaceRaw(secPerKm: number): string {
  const min = Math.floor(secPerKm / 60);
  const sec = Math.round(secPerKm % 60);
  return `${min}:${sec.toString().padStart(2, "0")}`;
}

/** Format pace as M:SS/km from sec/km */
export function formatPace(secPerKm: number): string {
  return `${formatPaceRaw(secPerKm)}/km`;
}

/** Extract YYYY-MM-DD date string from a Date (defaults to now) */
export function toDateString(date?: Date): string {
  return (date ?? new Date()).toISOString().split("T")[0];
}

const WEEKDAY_NAMES = [
  "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday",
];

/**
 * Full weekday name (e.g. "Tuesday") for a "YYYY-MM-DD" date key.
 * Parsed as a local calendar date so the result never shifts across timezones.
 * Use this instead of eyeballing weekdays from dates — see CLAUDE.md ("date math").
 */
export function weekdayFromDateKey(dateKey: string): string {
  const [y, m, d] = dateKey.slice(0, 10).split("-").map(Number);
  return WEEKDAY_NAMES[new Date(y, m - 1, d).getDay()];
}

/** Build a tool result response */
export function toolResult(text: string, isError?: boolean) {
  return {
    content: [{ type: "text" as const, text }],
    ...(isError ? { isError: true as const } : {}),
  };
}

/** Build a tool error response from a caught exception */
export function toolError(error: unknown) {
  const msg = error instanceof Error ? error.message : String(error);
  return toolResult(`Error: ${msg}`, true);
}

/** Sanitize a string for use as a filename */
export function sanitizeFilename(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}
