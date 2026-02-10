import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { loadHrZones, saveHrZones } from "../utils/hr-zones.js";
import type { HrZones } from "../types/index.js";

export const setHrZonesTool = tool(
  "set_hr_zones",
  "Sets the athlete's heart rate zone thresholds. Use when the athlete provides lactate test results, confirms estimated zones, or wants to manually set zones. Always marks zones as confirmed.",
  {
    lt1: z.number().describe("Aerobic threshold (LT1) heart rate"),
    lt2: z.number().describe("Anaerobic threshold (LT2) heart rate"),
    max_hr: z.number().describe("Maximum heart rate"),
    source: z.enum(["lactate_test", "estimated", "manual"]).describe("How the zones were determined"),
  },
  async ({ lt1, lt2, max_hr, source }) => {
    try {
      const zones: HrZones = { source, lt1, lt2, max_hr, confirmed: true };
      await saveHrZones(zones);
      return {
        content: [{
          type: "text" as const,
          text: `HR zones saved and confirmed:\n- LT1 (aerobic): ${lt1} bpm\n- LT2 (anaerobic): ${lt2} bpm\n- Max HR: ${max_hr} bpm\n- Source: ${source}\n\nRun strava_sync to classify activities with these zones.`,
        }],
      };
    } catch (error) {
      return {
        content: [{ type: "text" as const, text: `Error saving HR zones: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  }
);

export const getHrZonesTool = tool(
  "get_hr_zones",
  "Gets the athlete's current heart rate zone configuration and confirmation status.",
  {},
  async () => {
    try {
      const zones = await loadHrZones();
      const status = zones.confirmed
        ? "✓ Confirmed"
        : "⚠️ Unconfirmed (estimated) — ask the athlete to verify before classifying runs";
      return {
        content: [{
          type: "text" as const,
          text: `HR Zones (source: ${zones.source}) — ${status}\n- LT1 (aerobic): ${zones.lt1} bpm\n- LT2 (anaerobic): ${zones.lt2} bpm\n- Max HR: ${zones.max_hr} bpm\n\nZone breakdown:\n- Z1 (recovery): < ${Math.round(zones.lt1 * 0.88)} bpm\n- Z2 (easy): ${Math.round(zones.lt1 * 0.88)}-${zones.lt1} bpm\n- Z3 (tempo): ${zones.lt1}-${zones.lt2} bpm\n- Z4 (threshold): ${zones.lt2}-${Math.round(zones.max_hr * 0.97)} bpm\n- Z5 (VO2max): > ${Math.round(zones.max_hr * 0.97)} bpm`,
        }],
      };
    } catch (error) {
      return {
        content: [{ type: "text" as const, text: `Error loading HR zones: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  }
);
