export interface ExchangeUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
  durationMs: number;
  numTurns: number;
}

interface SessionUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
  durationMs: number;
  numTurns: number;
  exchangeCount: number;
}

let session: SessionUsage = createEmpty();

function createEmpty(): SessionUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: 0,
    durationMs: 0,
    numTurns: 0,
    exchangeCount: 0,
  };
}

export function recordExchange(exchange: ExchangeUsage): void {
  session.inputTokens += exchange.inputTokens;
  session.outputTokens += exchange.outputTokens;
  session.cacheReadTokens += exchange.cacheReadTokens;
  session.cacheCreationTokens += exchange.cacheCreationTokens;
  session.costUsd += exchange.costUsd;
  session.durationMs += exchange.durationMs;
  session.numTurns += exchange.numTurns;
  session.exchangeCount += 1;
}

export function getSessionUsage(): Readonly<SessionUsage> {
  return { ...session };
}

export function resetUsage(): void {
  session = createEmpty();
}

export function formatTokens(n: number): string {
  if (n >= 1000) {
    return `${(n / 1000).toFixed(1)}k`;
  }
  return String(n);
}

function formatCost(usd: number): string {
  const cents = usd * 100;
  if (cents < 0.05) return "0¢";
  return `${cents.toFixed(1)}¢`;
}

export function formatExchangeLine(exchange: ExchangeUsage): string {
  const turns = `${exchange.numTurns} turn${exchange.numTurns !== 1 ? "s" : ""}`;
  const duration = `${(exchange.durationMs / 1000).toFixed(1)}s`;
  const cost = formatCost(exchange.costUsd);
  const input = formatTokens(exchange.inputTokens);
  const output = formatTokens(exchange.outputTokens);
  const cached = exchange.cacheReadTokens > 0 ? ` (${formatTokens(exchange.cacheReadTokens)} cached)` : "";

  return `${turns} · ${duration} · ${cost} · ${input} in / ${output} out${cached}`;
}
