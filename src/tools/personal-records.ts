import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import {
  upsertPersonalRecord,
  getPersonalRecords,
  deletePersonalRecord,
} from "../utils/activities-db.js";

function formatTime(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.round(seconds % 60);
  if (hours > 0) {
    return `${hours}:${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
  }
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

export const managePersonalRecordsTool = tool(
  "manage_personal_records",
  "Store, retrieve, or delete the athlete's official race times (chip-timed results). These override GPS-computed best efforts for race prediction. Use when the athlete tells you their actual race time.",
  {
    action: z.enum(["set", "get", "delete"]).describe("Action to perform"),
    distance: z
      .string()
      .optional()
      .describe("Distance name: 1K, 5K, 10K, HALF, MARATHON (required for set/delete, optional for get)"),
    time_seconds: z.number().optional().describe("Official time in seconds (required for set)"),
    race_name: z.string().optional().describe("Race name, e.g. 'Spring 5K 2025' (required for set)"),
    race_date: z.string().optional().describe("Race date YYYY-MM-DD (required for set)"),
    notes: z.string().optional().describe("Additional notes"),
  },
  async ({ action, distance, time_seconds, race_name, race_date, notes }) => {
    try {
      if (action === "set") {
        if (!distance || !time_seconds || !race_name || !race_date) {
          return {
            content: [{
              type: "text" as const,
              text: "Missing required fields for set: distance, time_seconds, race_name, race_date",
            }],
            isError: true,
          };
        }
        upsertPersonalRecord({
          distance_name: distance.toUpperCase(),
          time_seconds,
          race_name,
          race_date,
          notes: notes ?? null,
        });
        return {
          content: [{
            type: "text" as const,
            text: `Saved official PR: ${distance.toUpperCase()} — ${formatTime(time_seconds)} at "${race_name}" (${race_date})`,
          }],
        };
      }

      if (action === "delete") {
        if (!distance) {
          return {
            content: [{ type: "text" as const, text: "Missing required field: distance" }],
            isError: true,
          };
        }
        const deleted = deletePersonalRecord(distance.toUpperCase());
        return {
          content: [{
            type: "text" as const,
            text: deleted
              ? `Deleted PR for ${distance.toUpperCase()}`
              : `No PR found for ${distance.toUpperCase()}`,
          }],
        };
      }

      // action === "get"
      const records = getPersonalRecords(distance?.toUpperCase());
      if (records.length === 0) {
        return {
          content: [{
            type: "text" as const,
            text: distance
              ? `No official PR recorded for ${distance.toUpperCase()}.`
              : "No official PRs recorded yet.",
          }],
        };
      }

      let output = "# Official Personal Records\n\n";
      output += "| Distance | Time | Pace | Race | Date |\n";
      output += "|----------|------|------|------|------|\n";
      for (const r of records) {
        const pacePerKm = r.time_seconds / (distanceToMeters(r.distance_name) / 1000);
        const pMin = Math.floor(pacePerKm / 60);
        const pSec = Math.round(pacePerKm % 60);
        output += `| ${r.distance_name} | **${formatTime(r.time_seconds)}** | ${pMin}:${pSec.toString().padStart(2, "0")}/km | ${r.race_name} | ${r.race_date} |\n`;
      }
      return { content: [{ type: "text" as const, text: output }] };
    } catch (error) {
      return {
        content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  }
);

function distanceToMeters(name: string): number {
  const map: Record<string, number> = {
    "1K": 1000,
    "5K": 5000,
    "10K": 10000,
    "HALF": 21097,
    "MARATHON": 42195,
  };
  return map[name] || 5000;
}
