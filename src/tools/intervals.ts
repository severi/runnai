import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import * as fs from "fs/promises";
import * as path from "path";
import { getDataDir } from "../utils/paths.js";
import { sanitizeFilename, toolResult, toolError } from "../utils/format.js";
import { parsePlan } from "../utils/plan-parser.js";
import type { IntervalsEvent } from "../intervals/client.js";
import {
  getIntervalsCredentials,
  workoutsToEvents,
  bulkUpsertEvents,
  listEvents,
  deleteEvent,
} from "../intervals/client.js";

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
        return toolResult(`Plan '${planName}' not found at ${filePath}.`, true);
      }

      const workouts = parsePlan(content, planSlug, weekFilter);

      if (workouts.length === 0) {
        return toolResult(`No workouts parsed from plan '${planName}'. Ensure the plan has ## Week N: headers with markdown tables containing Session and Details columns.`, true);
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
        return toolResult(JSON.stringify({
          planName,
          totalWorkouts: workouts.length,
          weeks: `${weekNums[0]}–${weekNums[weekNums.length - 1]}`,
          workouts: workoutData,
        }, null, 2));
      }

      // Live export
      let creds: { athleteId: string; apiKey: string };
      try {
        creds = getIntervalsCredentials();
      } catch (e) {
        return toolResult(`intervals.icu not configured. ${e instanceof Error ? e.message : String(e)}. Find your API key at https://intervals.icu/settings (Developer Settings).`, true);
      }

      const result = await bulkUpsertEvents(creds.athleteId, creds.apiKey, events);

      if (!result.success) {
        return toolResult(`Export failed: ${result.error}`, true);
      }

      const weekNums = [...new Set(workouts.map((w) => w.weekNumber))].sort((a, b) => a - b);
      return toolResult(`Exported "${planName}" to intervals.icu — ${result.eventCount} workout events (weeks ${weekNums[0]}–${weekNums[weekNums.length - 1]}). Re-exporting will safely update existing events.`);
    } catch (error) {
      return toolError(error);
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
        return toolResult(`intervals.icu not configured. ${e instanceof Error ? e.message : String(e)}`, true);
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
        return toolResult(`Push failed: ${result.error}`, true);
      }

      return toolResult(`Pushed ${result.eventCount} enriched workouts to intervals.icu with structured descriptions, tags, and colors.`);
    } catch (error) {
      return toolError(error);
    }
  },
);

export const listIntervalsEventsTool = tool(
  "list_intervals_events",
  "Fetch workout events currently on intervals.icu within a date range. Returns each event's server id, date, name, and external_id (null = orphan from a non-runnai export). Use this to inspect what's actually stored on the server, e.g., to find duplicates or stale entries.",
  {
    oldest: z.string().describe("Inclusive start date, YYYY-MM-DD"),
    newest: z.string().describe("Inclusive end date, YYYY-MM-DD"),
  },
  async ({ oldest, newest }) => {
    try {
      let creds: { athleteId: string; apiKey: string };
      try {
        creds = getIntervalsCredentials();
      } catch (e) {
        return toolResult(`intervals.icu not configured. ${e instanceof Error ? e.message : String(e)}`, true);
      }

      const events = await listEvents(creds.athleteId, creds.apiKey, oldest, newest);
      const summary = events
        .map(e => ({
          id: e.id,
          date: e.start_date_local.slice(0, 10),
          name: e.name,
          external_id: e.external_id,
        }))
        .sort((a, b) => a.date.localeCompare(b.date) || (a.external_id ?? "").localeCompare(b.external_id ?? ""));

      return toolResult(JSON.stringify({
        oldest,
        newest,
        total: events.length,
        runnai_tagged: events.filter(e => e.external_id?.startsWith("runnai:")).length,
        orphans: events.filter(e => e.external_id == null).length,
        events: summary,
      }, null, 2));
    } catch (error) {
      return toolError(error);
    }
  },
);

export const deleteIntervalsEventTool = tool(
  "delete_intervals_event",
  "Delete a single workout event from intervals.icu by its server id. Returns 'deleted' on success or already-gone (404). Use list_intervals_events first to find ids of stale/duplicate events.",
  {
    event_id: z.number().describe("Server-side event id from list_intervals_events"),
  },
  async ({ event_id }) => {
    try {
      let creds: { athleteId: string; apiKey: string };
      try {
        creds = getIntervalsCredentials();
      } catch (e) {
        return toolResult(`intervals.icu not configured. ${e instanceof Error ? e.message : String(e)}`, true);
      }
      await deleteEvent(creds.athleteId, creds.apiKey, event_id);
      return toolResult(`Deleted event ${event_id}.`);
    } catch (error) {
      return toolError(error);
    }
  },
);

export const reconcileIntervalsPlanTool = tool(
  "reconcile_intervals_plan",
  "Diff intervals.icu calendar against the local plan and (optionally) clean up. Identifies orphan events (no runnai: external_id) and stale runnai-tagged events whose external_id no longer matches the current plan parser. With apply=true, deletes those stale events AND re-pushes the current plan via upsert. With apply=false (default), reports what would happen without changes.",
  {
    planName: z.string().describe("Plan name (same as in manage_plan / export_to_intervals)"),
    oldest: z.string().describe("Date range start YYYY-MM-DD — typically today or the plan start"),
    newest: z.string().describe("Date range end YYYY-MM-DD — typically the plan's last race day"),
    apply: z.boolean().optional().describe("If true, perform deletes + re-push. If false (default), dry run."),
    weekFilter: z.array(z.number()).optional().describe("Limit reconciliation to specific plan weeks. Omit for all weeks intersecting the date range."),
  },
  async ({ planName, oldest, newest, apply = false, weekFilter }) => {
    try {
      let creds: { athleteId: string; apiKey: string };
      try {
        creds = getIntervalsCredentials();
      } catch (e) {
        return toolResult(`intervals.icu not configured. ${e instanceof Error ? e.message : String(e)}`, true);
      }

      // Load + parse current plan
      const planSlug = sanitizeFilename(planName);
      const filePath = path.join(getDataDir(), "plans", `${planSlug}.md`);
      let content: string;
      try {
        content = await fs.readFile(filePath, "utf-8");
      } catch {
        return toolResult(`Plan '${planName}' not found at ${filePath}.`, true);
      }
      const workouts = parsePlan(content, planSlug, weekFilter);
      const expectedEvents = workoutsToEvents(workouts);
      const expectedIds = new Set(expectedEvents.map(e => e.external_id));

      // Fetch what's actually on the server
      const serverEvents = await listEvents(creds.athleteId, creds.apiKey, oldest, newest);

      // Classify each server event
      const orphans = serverEvents.filter(e => e.external_id == null);
      const runnaiTagged = serverEvents.filter(e => e.external_id?.startsWith(`runnai:${planSlug}:`));
      const stale = runnaiTagged.filter(e => !expectedIds.has(e.external_id!));
      const aligned = runnaiTagged.filter(e => expectedIds.has(e.external_id!));
      const otherTagged = serverEvents.filter(
        e => e.external_id != null && !e.external_id.startsWith(`runnai:${planSlug}:`),
      );

      const toDelete = [...orphans, ...stale];

      const report = {
        planName,
        date_range: { oldest, newest },
        server: {
          total: serverEvents.length,
          orphans: orphans.length,
          runnai_aligned: aligned.length,
          runnai_stale: stale.length,
          other_tagged: otherTagged.length,
        },
        expected_from_current_plan: expectedEvents.length,
        to_delete: toDelete.map(e => ({
          id: e.id,
          date: e.start_date_local.slice(0, 10),
          name: e.name,
          external_id: e.external_id,
          reason: e.external_id == null ? "orphan" : "drifted_index",
        })),
        applied: false,
        deleted: 0,
        upserted: 0,
      };

      if (!apply) {
        return toolResult(JSON.stringify({
          ...report,
          note: "Dry run. Pass apply=true to delete the stale events and re-push the current plan via upsert.",
        }, null, 2));
      }

      // Apply: delete stale, then upsert current plan
      let deleted = 0;
      const deleteErrors: string[] = [];
      for (const e of toDelete) {
        try {
          await deleteEvent(creds.athleteId, creds.apiKey, e.id);
          deleted++;
        } catch (err) {
          deleteErrors.push(`event ${e.id} (${e.start_date_local.slice(0, 10)} "${e.name}"): ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      let upserted = 0;
      let upsertError: string | undefined;
      if (expectedEvents.length > 0) {
        const result = await bulkUpsertEvents(creds.athleteId, creds.apiKey, expectedEvents);
        if (result.success) {
          upserted = result.eventCount;
        } else {
          upsertError = result.error;
        }
      }

      return toolResult(JSON.stringify({
        ...report,
        applied: true,
        deleted,
        upserted,
        delete_errors: deleteErrors.length > 0 ? deleteErrors : undefined,
        upsert_error: upsertError,
      }, null, 2));
    } catch (error) {
      return toolError(error);
    }
  },
);
