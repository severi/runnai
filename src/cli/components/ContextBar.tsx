import React from "react";
import { Box, Text } from "ink";

interface ContextBarProps {
  used: number;
  total: number;
}

const BAR_WIDTH = 20;

/** Format token count compactly: 12345 → "12.3k", 1234567 → "1.23M" */
function formatTokens(n: number): string {
  if (n < 1000) return n.toString();
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function colorForPercent(pct: number): "green" | "yellow" | "red" {
  if (pct < 50) return "green";
  if (pct < 80) return "yellow";
  return "red";
}

/** Bar like █████░░░░░░░░░░░░░░░ where the filled portion reflects pct. */
function renderBar(pct: number): string {
  const filled = Math.min(BAR_WIDTH, Math.max(0, Math.round((pct / 100) * BAR_WIDTH)));
  return "█".repeat(filled) + "░".repeat(BAR_WIDTH - filled);
}

export function ContextBar({ used, total }: ContextBarProps) {
  if (total <= 0) return null;
  const pct = (used / total) * 100;
  const color = colorForPercent(pct);
  const warning = pct >= 85 ? " · compaction soon" : "";
  return (
    <Box paddingX={1}>
      <Text dimColor>context </Text>
      <Text color={color}>{renderBar(pct)}</Text>
      <Text dimColor>
        {" "}{formatTokens(used)}/{formatTokens(total)} ({pct.toFixed(1)}%){warning}
      </Text>
    </Box>
  );
}
