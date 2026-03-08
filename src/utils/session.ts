let currentSessionId: string | null = null;

export function getCurrentSessionId(): string | null {
  return currentSessionId;
}

export function setSessionId(id: string): void {
  currentSessionId = id;
}
