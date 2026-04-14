import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { generateAerobicChart } from "../utils/aerobic-chart.js";
import { toolResult, toolError } from "../utils/format.js";

export const generateAerobicChartTool = tool(
  "generate_aerobic_chart",
  "Generate a 4-panel PNG chart showing the athlete's aerobic fitness development over time. Panels: (1) weekly Z2 runs with HR + pace dual-axis trends, (2) Efficiency Factor (speed per heartbeat) scatter + trend — the headline aerobic metric, (3) pace at fixed HR band (140-150 bpm) showing how easy pace evolves at constant effort, (4) monthly HR->pace regression lines showing the full relationship shifting. The chart is written to data/charts/ and auto-opened on macOS. Use this when the athlete asks about aerobic development, Z2 progression, fitness improvement, or wants to visualize training trends. Returns a summary of the chart and the file path.",
  {
    months: z
      .number()
      .int()
      .min(1)
      .max(24)
      .optional()
      .describe("Months of history to include. Defaults to 8 months."),
  },
  async ({ months }) => {
    try {
      const result = await generateAerobicChart(months ?? 8);
      if (result.runCount === 0) {
        return toolResult(result.summary);
      }
      return toolResult(`${result.summary}\n\nChart saved to: ${result.outputPath}`);
    } catch (error) {
      return toolError(error);
    }
  }
);
