import * as fs from "fs/promises";
import * as path from "path";
import { getDataDir } from "./paths.js";

let currentSessionId: string | null = null;

export function getCurrentSessionId(): string | null {
  return currentSessionId;
}

export function setSessionId(id: string): void {
  currentSessionId = id;
}

function sessionFile(): string {
  return path.join(getDataDir(), ".session");
}

export function isValidSessionId(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

/** Fire-and-forget — called on every SDK init so `--resume` finds the last session. */
export function persistSessionId(id: string): void {
  fs.writeFile(sessionFile(), id).catch(() => {});
}

export async function loadPersistedSessionId(): Promise<string | null> {
  try {
    const id = (await fs.readFile(sessionFile(), "utf-8")).trim();
    return isValidSessionId(id) ? id : null;
  } catch {
    return null;
  }
}
