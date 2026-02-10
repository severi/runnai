import * as fs from "fs/promises";
import * as path from "path";
import { fileURLToPath } from "url";
import type { Message } from "../cli/commands.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "../..");
const SESSION_FILE = path.join(PROJECT_ROOT, "data/.session");
const HISTORY_FILE = path.join(PROJECT_ROOT, "data/.chat-history.json");

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
    const data = await fs.readFile(SESSION_FILE, "utf-8");
    return data.trim() || null;
  } catch {
    return null;
  }
}

export async function saveSession(id: string): Promise<void> {
  currentSessionId = id;
  await fs.writeFile(SESSION_FILE, id, "utf-8");
}

export async function clearPersistedSession(): Promise<void> {
  currentSessionId = null;
  try {
    await fs.unlink(SESSION_FILE);
  } catch {}
  try {
    await fs.unlink(HISTORY_FILE);
  } catch {}
}

export async function appendChatMessage(message: Message): Promise<void> {
  const history = await loadChatHistory();
  history.push(message);
  await fs.writeFile(HISTORY_FILE, JSON.stringify(history), "utf-8");
}

export async function loadChatHistory(): Promise<Message[]> {
  try {
    const data = await fs.readFile(HISTORY_FILE, "utf-8");
    return JSON.parse(data);
  } catch {
    return [];
  }
}

export async function clearChatHistory(): Promise<void> {
  try {
    await fs.unlink(HISTORY_FILE);
  } catch {}
}
