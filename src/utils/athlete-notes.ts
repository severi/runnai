/**
 * The athlete's own Strava description is the one Class C source the data
 * pipeline can carry: intent, how it felt, what happened off the watch. It is
 * exposed to the coach as `athlete_notes` and quoted, never adjudicated.
 */

/** Appended to every description the coach pushes to Strava. */
export const STRAVA_ATTRIBUTION = "\n🏃 RunnAI → severi.github.io/runnai";

/**
 * Turn a stored Strava description into athlete-authored notes.
 *
 * Returns null for empty text and for the coach's own write-back: after a push
 * the live description is the coach's public post plus the attribution line,
 * and re-syncing it must not hand the coach's words back as the athlete's account.
 */
export function athleteNotesFromDescription(description: string | null | undefined): string | null {
  if (!description) return null;
  if (description.includes(STRAVA_ATTRIBUTION.trim())) return null;
  const text = description.trim();
  return text.length > 0 ? text : null;
}
