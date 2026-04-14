import * as fs from "fs/promises";
import * as path from "path";
import { getDataDir } from "./paths.js";
import { toDateString } from "./format.js";
import type { TrainingZones, PaceZones, HrZones, ZoneHistoryEntry, PaceZoneName, PaceRange } from "../types/index.js";

function getTrainingZonesFile(): string {
  return path.join(getDataDir(), "athlete/training-zones.json");
}

function getLegacyHrZonesFile(): string {
  return path.join(getDataDir(), "athlete/hr-zones.json");
}

function getZonesHistoryFile(): string {
  return path.join(getDataDir(), "athlete/zones-history.jsonl");
}

/**
 * Load the training zones file. On first read, migrates a pre-existing
 * legacy hr-zones.json into the new shape (paces remain null until set).
 */
export async function loadTrainingZones(): Promise<TrainingZones | null> {
  try {
    const data = await fs.readFile(getTrainingZonesFile(), "utf-8");
    return JSON.parse(data) as TrainingZones;
  } catch {
    // No new file — try to migrate from legacy hr-zones.json
    try {
      const legacy = await fs.readFile(getLegacyHrZonesFile(), "utf-8");
      const hrOnly = JSON.parse(legacy) as HrZones;
      const migrated: TrainingZones = {
        hr: { ...hrOnly, confirmed: hrOnly.confirmed ?? true, updated_at: toDateString() },
        pace: null,
      };
      await saveTrainingZones(migrated);
      return migrated;
    } catch {
      return null;
    }
  }
}

export async function saveTrainingZones(zones: TrainingZones): Promise<void> {
  await fs.mkdir(path.dirname(getTrainingZonesFile()), { recursive: true });
  await fs.writeFile(getTrainingZonesFile(), JSON.stringify(zones, null, 2));
}

/**
 * Save HR zones into the training-zones.json file. Creates the file (with
 * pace=null) if it does not exist. Also writes an audit entry to the history.
 */
export async function saveHrZonesPart(
  hr: HrZones,
  options: { approvedBy?: string; notes?: string; basis?: Record<string, unknown> } = {}
): Promise<void> {
  const existing = (await loadTrainingZones()) ?? { hr: { ...hr, updated_at: toDateString() }, pace: null };
  existing.hr = { ...hr, updated_at: toDateString() };
  await saveTrainingZones(existing);
  await appendZoneHistory({
    date: toDateString(),
    type: "hr",
    source: hr.source,
    values: { lt1: hr.lt1, lt2: hr.lt2, max_hr: hr.max_hr },
    approved_by: options.approvedBy,
    basis: options.basis,
    notes: options.notes,
  });
}

/**
 * Save the pace sub-object. Requires that an HR sub-object already exists.
 * Also writes an audit entry to the history with full basis context.
 */
export async function savePaceZones(
  pace: PaceZones,
  options: { approvedBy?: string; notes?: string; basis?: Record<string, unknown> } = {}
): Promise<void> {
  const existing = await loadTrainingZones();
  if (!existing) {
    throw new Error("Cannot save pace zones before HR zones exist. Set HR zones first.");
  }
  const prior = existing.pace;
  existing.pace = { ...pace, updated_at: toDateString() };
  await saveTrainingZones(existing);
  await appendZoneHistory({
    date: toDateString(),
    type: "pace",
    source: pace.source,
    values: {
      recovery: pace.recovery,
      easy: pace.easy,
      marathon: pace.marathon,
      tempo: pace.tempo,
      threshold: pace.threshold,
    },
    basis: { ...options.basis, prior },
    approved_by: options.approvedBy,
    notes: options.notes ?? pace.derivation_notes,
  });
}

/**
 * Append an audit entry to the zones history JSONL file.
 * Append-only: never edits existing entries.
 */
export async function appendZoneHistory(entry: ZoneHistoryEntry): Promise<void> {
  await fs.mkdir(path.dirname(getZonesHistoryFile()), { recursive: true });
  await fs.appendFile(getZonesHistoryFile(), JSON.stringify(entry) + "\n");
}

/**
 * Read the zones history (most recent first).
 */
export async function readZoneHistory(limit?: number): Promise<ZoneHistoryEntry[]> {
  try {
    const content = await fs.readFile(getZonesHistoryFile(), "utf-8");
    const lines = content.trim().split("\n").filter(l => l.length > 0);
    const entries = lines.map(l => JSON.parse(l) as ZoneHistoryEntry).reverse();
    return limit ? entries.slice(0, limit) : entries;
  } catch {
    return [];
  }
}

/**
 * Format a pace value (sec/km) as "M:SS".
 */
export function formatPaceSec(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/**
 * Format a pace range as "M:SS–M:SS/km".
 */
export function formatPaceRange(range: PaceRange): string {
  return `${formatPaceSec(range.min_sec)}–${formatPaceSec(range.max_sec)}/km`;
}

/**
 * Format the full pace zones block for display in CONTEXT.md or system prompt.
 */
export function formatPaceZonesBlock(pace: PaceZones | null): string {
  if (!pace) return "No pace zones set yet.";
  const lines = [
    `Recovery: ${formatPaceRange(pace.recovery)}`,
    `Easy:     ${formatPaceRange(pace.easy)}`,
    `Marathon: ${formatPaceRange(pace.marathon)}`,
    `Tempo:    ${formatPaceRange(pace.tempo)}`,
    `Threshold: ${formatPaceRange(pace.threshold)}`,
  ];
  return lines.join("\n");
}

/**
 * Look up a single pace zone by name. Returns null if pace zones are unset.
 */
export function getPaceZone(zones: TrainingZones | null, name: PaceZoneName): PaceRange | null {
  if (!zones?.pace) return null;
  return zones.pace[name];
}
