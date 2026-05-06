/** Format seconds for status indicators: "Xs" under a minute, otherwise "XmYYs". */
export function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const min = Math.floor(seconds / 60);
  const sec = seconds % 60;
  return `${min}m ${sec.toString().padStart(2, "0")}s`;
}
