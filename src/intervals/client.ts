import type { ParsedWorkout } from "../utils/plan-parser.js";

export interface IntervalsEvent {
  category: "WORKOUT";
  start_date_local: string;
  name: string;
  description: string;
  type: "Run";
  external_id: string;
  color?: string;
  tags?: string[];
}

export interface BulkUpsertResult {
  success: boolean;
  eventCount: number;
  error?: string;
}

const BASE_URL = "https://intervals.icu";

export function getIntervalsCredentials(): { athleteId: string; apiKey: string } {
  const apiKey = process.env.INTERVALS_ICU_API_KEY;
  const athleteId = process.env.INTERVALS_ICU_ATHLETE_ID;

  if (!apiKey) throw new Error("INTERVALS_ICU_API_KEY not set in .env");
  if (!athleteId) throw new Error("INTERVALS_ICU_ATHLETE_ID not set in .env");

  return { apiKey, athleteId };
}

export function workoutsToEvents(workouts: ParsedWorkout[]): IntervalsEvent[] {
  return workouts.map((w) => ({
    category: "WORKOUT",
    start_date_local: w.date,
    name: w.sessionName,
    description: w.details,
    type: "Run",
    external_id: w.externalId,
  }));
}

export async function bulkUpsertEvents(
  athleteId: string,
  apiKey: string,
  events: IntervalsEvent[],
): Promise<BulkUpsertResult> {
  const creds = Buffer.from(`API_KEY:${apiKey}`).toString("base64");

  const response = await fetch(
    `${BASE_URL}/api/v1/athlete/${athleteId}/events/bulk?upsert=true`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${creds}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(events),
    },
  );

  if (!response.ok) {
    const errorText = await response.text();
    return {
      success: false,
      eventCount: 0,
      error: `intervals.icu API error (${response.status}): ${errorText}`,
    };
  }

  const result = (await response.json()) as unknown[];
  return { success: true, eventCount: result.length };
}

export interface IntervalsServerEvent {
  id: number;
  start_date_local: string;
  name: string;
  category: string;
  type: string | null;
  description: string | null;
  external_id: string | null;
  athlete_id?: string;
}

function basicAuth(apiKey: string): string {
  return "Basic " + Buffer.from(`API_KEY:${apiKey}`).toString("base64");
}

/** List events on intervals.icu within a date range. Dates are YYYY-MM-DD (inclusive). */
export async function listEvents(
  athleteId: string,
  apiKey: string,
  oldest: string,
  newest: string,
  category: string = "WORKOUT",
): Promise<IntervalsServerEvent[]> {
  const url = `${BASE_URL}/api/v1/athlete/${athleteId}/events?oldest=${oldest}&newest=${newest}&category=${category}`;
  const response = await fetch(url, {
    headers: { Authorization: basicAuth(apiKey) },
  });
  if (!response.ok) {
    throw new Error(`intervals.icu list failed (${response.status}): ${await response.text()}`);
  }
  return (await response.json()) as IntervalsServerEvent[];
}

/** Delete a single event by its server-side id. */
export async function deleteEvent(
  athleteId: string,
  apiKey: string,
  eventId: number,
): Promise<void> {
  const url = `${BASE_URL}/api/v1/athlete/${athleteId}/events/${eventId}`;
  const response = await fetch(url, {
    method: "DELETE",
    headers: { Authorization: basicAuth(apiKey) },
  });
  if (!response.ok && response.status !== 404) {
    throw new Error(`intervals.icu delete failed (${response.status}): ${await response.text()}`);
  }
}
