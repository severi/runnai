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
