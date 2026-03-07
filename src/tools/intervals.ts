import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import * as fs from "fs/promises";
import * as path from "path";
import { getDataDir } from "../utils/paths.js";
import { sanitizeFilename } from "../utils/format.js";
import { parsePlan } from "../utils/plan-parser.js";
import type { IntervalsEvent } from "../intervals/client.js";
import { getIntervalsCredentials, workoutsToEvents, bulkUpsertEvents } from "../intervals/client.js";

export const exportToIntervalsTool = tool(
  "export_to_intervals",
  "Export a training plan to intervals.icu as calendar workout events. Parses the markdown plan and creates or updates events via the intervals.icu bulk API. Rest days are skipped. Re-exporting the same plan safely updates existing events via upsert.",
  {
    planName: z.string().describe("Name of the training plan (same as used in manage_plan)"),
    dryRun: z.boolean().optional().describe("If true, parse and show what would be exported without calling the API. Default false."),
    weekFilter: z.array(z.number()).optional().describe("Only export specific week numbers (1-based). Omit to export all weeks."),
  },
  async ({ planName, dryRun = false, weekFilter }) => {
    try {
      const planSlug = sanitizeFilename(planName);
      const filePath = path.join(getDataDir(), "plans", `${planSlug}.md`);

      let content: string;
      try {
        content = await fs.readFile(filePath, "utf-8");
      } catch {
        return {
          content: [{ type: "text" as const, text: `Plan '${planName}' not found at ${filePath}.` }],
          isError: true,
        };
      }

      const workouts = parsePlan(content, planSlug, weekFilter);

      if (workouts.length === 0) {
        return {
          content: [{
            type: "text" as const,
            text: `No workouts parsed from plan '${planName}'. Ensure the plan has ## Week N: headers with markdown tables containing Session and Details columns.`,
          }],
          isError: true,
        };
      }

      const events = workoutsToEvents(workouts);

      if (dryRun) {
        const weekNums = [...new Set(workouts.map((w) => w.weekNumber))].sort((a, b) => a - b);
        const workoutData = workouts.map((w) => ({
          weekNumber: w.weekNumber,
          date: w.date.split("T")[0],
          sessionName: w.sessionName,
          details: w.details,
          externalId: w.externalId,
        }));
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              planName,
              totalWorkouts: workouts.length,
              weeks: `${weekNums[0]}–${weekNums[weekNums.length - 1]}`,
              workouts: workoutData,
            }, null, 2),
          }],
        };
      }

      // Live export
      let creds: { athleteId: string; apiKey: string };
      try {
        creds = getIntervalsCredentials();
      } catch (e) {
        return {
          content: [{
            type: "text" as const,
            text: `intervals.icu not configured. ${e instanceof Error ? e.message : String(e)}. Find your API key at https://intervals.icu/settings (Developer Settings).`,
          }],
          isError: true,
        };
      }

      const result = await bulkUpsertEvents(creds.athleteId, creds.apiKey, events);

      if (!result.success) {
        return {
          content: [{ type: "text" as const, text: `Export failed: ${result.error}` }],
          isError: true,
        };
      }

      const weekNums = [...new Set(workouts.map((w) => w.weekNumber))].sort((a, b) => a - b);
      return {
        content: [{
          type: "text" as const,
          text: `Exported "${planName}" to intervals.icu — ${result.eventCount} workout events (weeks ${weekNums[0]}–${weekNums[weekNums.length - 1]}). Re-exporting will safely update existing events.`,
        }],
      };
    } catch (error) {
      return {
        content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  },
);

const intervalsEventSchema = z.object({
  start_date_local: z.string().describe("ISO date: YYYY-MM-DDT00:00:00"),
  name: z.string().describe("Workout name (e.g., 'Easy', 'Tempo', 'Long Run + MP Finish')"),
  description: z.string().describe(`Structured workout description using intervals.icu syntax. Each step starts with '-'.

SYNTAX REFERENCE:
  Duration: 9km, 2km, 0.5km (distance) or 30m, 10m, 1h (time)
  CRITICAL: do NOT use 'm' suffix for meters — '500m' means 500 MINUTES. Use '0.5km' instead.
  HR zones: Z1 HR, Z2 HR, Z3 HR, Z4 HR, Z5 HR
  Absolute pace: 5:19/km Pace
  Labels: text after target, e.g., Warmup, Easy, Tempo, Marathon Pace

STEP FORMAT: - <distance_or_time> <target> [Label]
  Examples:
    - 9km Z2 HR Easy
    - 2km Z1 HR Warmup
    - 30m Z3 HR Tempo
    - 8km 5:19/km Pace Marathon Pace
    - 2km Z1 HR Cooldown

REPEATS: number followed by 'x', then indented steps. MUST have blank line before AND after the repeat block.
  Example:
    - 2km Z2 HR Warmup

    4x
    - 1km Z4 HR Hard
    - 0.5km Z1 HR Recovery

    - 2km Z1 HR Cooldown

RAMP (progressive): - 10km ramp Z1-Z3 HR Progressive

ATHLETE ZONES (from Pajulahti lab test):
  Z1 PK1: 117-137 bpm (recovery, 7:42-6:36/km)
  Z2 PK2: 138-152 bpm (easy/aerobic, 6:35-5:46/km)
  Z3 VK1: 153-165 bpm (tempo, 5:45-4:58/km)
  Z4 VK2: 166-178 bpm (threshold, 4:57-4:21/km)
  Z5 MK: 179-197 bpm (VO2max)
  Marathon Pace: 5:19/km (~160-168 bpm)

Use HR zones (Z1 HR, Z2 HR, etc.) for easy/recovery runs. Use absolute pace (5:19/km Pace) for specific pace targets like marathon pace. Prefer HR zones over pace zones since they match the lab test configuration in intervals.icu.`),
  external_id: z.string().describe("External ID for upsert (from dry run output)"),
  color: z.string().optional().describe(`Hex color code for the workout. Suggested mapping:
  Easy: #4CAF50 (green)
  Recovery: #81C784 (light green)
  Tempo: #FF9800 (orange)
  Long Run: #9C27B0 (purple)
  Mid-Long: #7B1FA2 (dark purple)
  Marathon Pace: #F44336 (red)
  Intervals: #FF5722 (deep orange)
  Progressive: #2196F3 (blue)
  Hill Repeats: #795548 (brown)
  Strides: #00BCD4 (cyan)
  Race: #FFD700 (gold)
  Shakeout: #90A4AE (grey)`),
  tags: z.array(z.string()).optional().describe(`Tags for the workout. Use existing activity tags where matching: recovery, tempo, long, midlong, trail. New tags: easy, intervals, race, marathon-pace, progressive, hill-repeats, strides, shakeout`),
});

export const pushToIntervalsTool = tool(
  "push_to_intervals",
  "Push enriched workout events to intervals.icu. Use this after export_to_intervals(dryRun=true) to push workouts with structured descriptions, tags, and colors. The structured description field is parsed by intervals.icu into visual workout steps with HR/pace targets, auto-calculated distance, duration, and training load.",
  {
    events: z.array(intervalsEventSchema).describe("Array of enriched workout events to push"),
  },
  async ({ events }) => {
    try {
      let creds: { athleteId: string; apiKey: string };
      try {
        creds = getIntervalsCredentials();
      } catch (e) {
        return {
          content: [{
            type: "text" as const,
            text: `intervals.icu not configured. ${e instanceof Error ? e.message : String(e)}`,
          }],
          isError: true,
        };
      }

      const intervalsEvents: IntervalsEvent[] = events.map((e) => ({
        category: "WORKOUT" as const,
        type: "Run" as const,
        start_date_local: e.start_date_local,
        name: e.name,
        description: e.description,
        external_id: e.external_id,
        color: e.color,
        tags: e.tags,
      }));

      const result = await bulkUpsertEvents(creds.athleteId, creds.apiKey, intervalsEvents);

      if (!result.success) {
        return {
          content: [{ type: "text" as const, text: `Push failed: ${result.error}` }],
          isError: true,
        };
      }

      return {
        content: [{
          type: "text" as const,
          text: `Pushed ${result.eventCount} enriched workouts to intervals.icu with structured descriptions, tags, and colors.`,
        }],
      };
    } catch (error) {
      return {
        content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  },
);
