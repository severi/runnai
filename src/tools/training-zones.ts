import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import {
  loadTrainingZones,
  savePaceZones,
  readZoneHistory,
  formatPaceRange,
  formatPaceZonesBlock,
} from "../utils/training-zones.js";
import { computeFitnessDrift } from "../utils/fitness-drift.js";
import { toolResult, toolError } from "../utils/format.js";
import type { PaceZones, PaceRange } from "../types/index.js";

const paceRangeSchema = z.object({
  min_sec: z.number().int().describe("Faster end of the range, sec/km"),
  max_sec: z.number().int().describe("Slower end of the range, sec/km"),
});

export const getTrainingZonesTool = tool(
  "get_training_zones",
  "Get the athlete's current HR and pace zones from training-zones.json. This is the source of truth for all zone information — use this BEFORE prescribing workouts so you reference the athlete's current capability, not stale values from the plan file.",
  {},
  async () => {
    try {
      const zones = await loadTrainingZones();
      if (!zones) {
        return toolResult("No training zones set yet. Run /setup or set HR zones via set_hr_zones first.");
      }
      const hr = zones.hr;
      const z1Top = Math.round(hr.lt1 * 0.88);
      const z4Top = Math.round(hr.max_hr * 0.97);
      const hrBlock = `HR Zones (${hr.source}, updated ${hr.updated_at}):
- Z1 recovery: < ${z1Top} bpm
- Z2 easy:     ${z1Top}–${hr.lt1} bpm
- Z3 tempo:    ${hr.lt1}–${hr.lt2} bpm
- Z4 threshold: ${hr.lt2}–${z4Top} bpm
- Z5 VO2max:   > ${z4Top} bpm`;

      const paceBlock = zones.pace
        ? `\n\nPace Zones (${zones.pace.source}, updated ${zones.pace.updated_at}):
${formatPaceZonesBlock(zones.pace)}\n\nDerivation: ${zones.pace.derivation_notes}`
        : "\n\nPace Zones: NOT SET. Use update_pace_zones to set them based on training data or lab values.";

      return toolResult(hrBlock + paceBlock);
    } catch (error) {
      return toolError(error);
    }
  }
);

export const updatePaceZonesTool = tool(
  "update_pace_zones",
  "Update the athlete's pace zones in training-zones.json. Use this AFTER the athlete confirms a zone change (e.g., after a fitness drift signal at session start, after a new lactate test, or after a manual adjustment). Always include a clear derivation_notes string and the source. Writes an audit entry to zones-history.jsonl with the prior values for traceability. PRECONDITION: HR zones must already exist (call set_hr_zones first if not). All five pace ranges (recovery, easy, marathon, tempo, threshold) are required — pass current values for any zones you don't intend to change.",
  {
    recovery: paceRangeSchema.describe("Recovery / very easy pace range, sec/km"),
    easy: paceRangeSchema.describe("Easy / aerobic Z2 pace range, sec/km"),
    marathon: paceRangeSchema.describe("Marathon pace range, sec/km"),
    tempo: paceRangeSchema.describe("Tempo / Z3 pace range, sec/km"),
    threshold: paceRangeSchema.describe("Threshold / Z4 pace range, sec/km"),
    source: z
      .enum(["lactate_test", "derived_from_training", "manual"])
      .describe("How these zones were determined"),
    derivation_notes: z
      .string()
      .describe("Clear human-readable note about how these were derived (e.g., 'Rolling median of easy phase pace at HR 140-150, last 22 valid runs over 3 weeks; supersedes Jan 2 lab values')"),
    sample_count: z
      .number()
      .int()
      .optional()
      .describe("If source is derived_from_training, the number of phase samples used"),
    date_range_start: z
      .string()
      .optional()
      .describe("First date of training data used (YYYY-MM-DD)"),
    date_range_end: z
      .string()
      .optional()
      .describe("Last date of training data used (YYYY-MM-DD)"),
  },
  async ({ recovery, easy, marathon, tempo, threshold, source, derivation_notes, sample_count, date_range_start, date_range_end }) => {
    try {
      const pace: PaceZones = {
        source,
        recovery,
        easy,
        marathon,
        tempo,
        threshold,
        updated_at: new Date().toISOString().slice(0, 10),
        derivation_notes,
      };

      const basis: Record<string, unknown> = {};
      if (sample_count !== undefined) basis.sample_count = sample_count;
      if (date_range_start) basis.date_range_start = date_range_start;
      if (date_range_end) basis.date_range_end = date_range_end;

      await savePaceZones(pace, {
        approvedBy: "athlete",
        notes: derivation_notes,
        basis: Object.keys(basis).length > 0 ? basis : undefined,
      });

      return toolResult(
        `Pace zones updated and saved:\n${formatPaceZonesBlock(pace)}\n\nSource: ${source}\nNotes: ${derivation_notes}\n\nAudit entry written to data/athlete/zones-history.jsonl. The plan file's per-row pace strings are now stale — when prescribing workouts, always reference these current zones rather than any pace text in the plan markdown.`
      );
    } catch (error) {
      return toolError(error);
    }
  }
);

export const getFitnessDriftTool = tool(
  "get_fitness_drift",
  "Compute the current fitness drift signal: compare the athlete's recent training-data-derived easy pace at Z2 HR against the stored easy zone in training-zones.json. Returns observed pace, sample count, delta, direction, and confidence. Use this to verify a startup-prompt drift signal, or on demand when the athlete asks 'is my fitness improving?'.",
  {},
  async () => {
    try {
      const drift = await computeFitnessDrift();
      if (!drift) {
        return toolResult("Fitness drift cannot be computed: HR zones are not yet confirmed. Run set_hr_zones first.");
      }
      return toolResult(JSON.stringify(drift, null, 2));
    } catch (error) {
      return toolError(error);
    }
  }
);

export const getZoneHistoryTool = tool(
  "get_zone_history",
  "Read the audit trail of zone changes from zones-history.jsonl. Each entry records when HR or pace zones were updated, the new values, the basis (sample count, prior values, who approved), and a note. Use this when the athlete asks about their fitness progression, or to validate that a change was logged.",
  {
    limit: z.number().int().optional().describe("Maximum entries to return (most recent first). Defaults to 20."),
  },
  async ({ limit }) => {
    try {
      const entries = await readZoneHistory(limit ?? 20);
      if (entries.length === 0) {
        return toolResult("No zone history yet. The first entry will be written when set_hr_zones or update_pace_zones is called.");
      }
      const isPaceRange = (v: unknown): v is PaceRange =>
        typeof v === "object" && v !== null && "min_sec" in v && "max_sec" in v &&
        typeof (v as { min_sec: unknown }).min_sec === "number" &&
        typeof (v as { max_sec: unknown }).max_sec === "number";
      const lines = entries.map(e => {
        const head = `${e.date} [${e.type}] source=${e.source}${e.approved_by ? ` approved_by=${e.approved_by}` : ""}`;
        const valueLine =
          e.type === "pace"
            ? Object.entries(e.values)
                .map(([k, v]) => isPaceRange(v) ? `  ${k}: ${formatPaceRange(v)}` : `  ${k}: ${JSON.stringify(v)}`)
                .join("\n")
            : `  ${JSON.stringify(e.values)}`;
        const noteLine = e.notes ? `  notes: ${e.notes}` : "";
        return [head, valueLine, noteLine].filter(Boolean).join("\n");
      });
      return toolResult(`Zone history (${entries.length} entries, most recent first):\n\n${lines.join("\n\n")}`);
    } catch (error) {
      return toolError(error);
    }
  }
);
