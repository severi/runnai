import * as fs from "fs/promises";
import * as path from "path";
import { getDataDir } from "./paths.js";
import type { Message } from "../cli/commands.js";

const HISTORY_ROLES = new Set(["user", "assistant", "system"]);

function historyFile(): string {
  return path.join(getDataDir(), ".chat-history.jsonl");
}

export function serializeChatLine(role: Message["role"], content: string): string {
  return JSON.stringify({ role, content, ts: new Date().toISOString() }) + "\n";
}

export function parseChatHistory(text: string, limit = 100): Message[] {
  const messages: Message[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (typeof parsed.role !== "string" || !HISTORY_ROLES.has(parsed.role)) continue;
      if (typeof parsed.content !== "string") continue;
      messages.push({ role: parsed.role as Message["role"], content: parsed.content });
    } catch {
      // Corrupt line (e.g. crash mid-append) — skip, keep the rest
    }
  }
  return messages.slice(-limit);
}

/** O(1) append; fire-and-forget — history must never block the UI. */
export function appendChatMessage(role: Message["role"], content: string): void {
  fs.appendFile(historyFile(), serializeChatLine(role, content)).catch(() => {});
}

export async function loadChatHistory(limit = 100): Promise<Message[]> {
  try {
    const text = await fs.readFile(historyFile(), "utf-8");
    return parseChatHistory(text, limit);
  } catch {
    return [];
  }
}

/** Fresh (non-resume) session — history must match the live SDK session. */
export async function resetChatHistory(): Promise<void> {
  await fs.writeFile(historyFile(), "").catch(() => {});
}
