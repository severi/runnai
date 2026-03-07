import * as fs from "fs/promises";
import * as path from "path";
import { getDataDir } from "./paths.js";
import type { Message } from "../cli/commands.js";

function getSessionFile(): string {
  return path.join(getDataDir(), ".session");
}

function getHistoryFile(): string {
  return path.join(getDataDir(), ".chat-history.jsonl");
}

let currentSessionId: string | null = null;

export function getCurrentSessionId(): string | null {
  return currentSessionId;
}

export function setSessionId(id: string): void {
  currentSessionId = id;
}

export function resetSession(): void {
  currentSessionId = null;
}

export async function loadPersistedSession(): Promise<string | null> {
  try {
    const data = await fs.readFile(getSessionFile(), "utf-8");
    return data.trim() || null;
  } catch {
    return null;
  }
}

export async function saveSession(id: string): Promise<void> {
  currentSessionId = id;
  await fs.writeFile(getSessionFile(), id, "utf-8");
}

export async function clearPersistedSession(): Promise<void> {
  currentSessionId = null;
  try { await fs.unlink(getSessionFile()); } catch {}
  try { await fs.unlink(getHistoryFile()); } catch {}
  // Clean up old JSON format file from before JSONL migration
  try { await fs.unlink(path.join(getDataDir(), ".chat-history.json")); } catch {}
}

export async function appendChatMessage(message: Message): Promise<void> {
  await fs.appendFile(getHistoryFile(), JSON.stringify(message) + "\n", "utf-8");
}

export async function loadChatHistory(): Promise<Message[]> {
  try {
    const data = await fs.readFile(getHistoryFile(), "utf-8");
    return data
      .split("\n")
      .filter(line => line.length > 0)
      .map(line => JSON.parse(line));
  } catch {
    return [];
  }
}
