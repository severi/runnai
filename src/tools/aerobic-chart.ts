import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { generateAerobicChart } from "../utils/aerobic-chart.js";
import { toolResult, toolError } from "../utils/format.js";

export const generateAerobicChartTool = tool(
  "generate_aerobic_chart",
  "The long-horizon fitness read: has the athlete progressed? Builds ONE comparable cohort (outdoor easy runs at Z2 HR, 5–35 km, flat, not hard sessions, no stroller/load tags), computes ONE metric (efficiency factor = grade-adjusted speed per heartbeat, from stream analysis), and ONE method (median over trailing 90-day windows), then draws a 3-panel PNG: (1) weekly volume with the 90-day EF trend overlaid, (2) per-run EF coloured by temperature with the rolling median and IQR band, (3) the same series as easy pace at the band's reference HR. Returns the window comparison (now vs first window, vs a year ago, vs peak), a monthly table with temperature and sub-zero counts, exclusion counts and data-quality notes. Quote the windows it prints — do not re-derive a headline from single months. Pass `annotations` from memory (races, illness, lab tests, big training blocks) so dips are drawn in context; races already classified in the DB are added automatically. Use for 'have I progressed', 'what's the trend', 'am I fitter than last year / than before the test'. For a 60-day zone check use get_fitness_drift instead. The chart auto-opens on macOS.",
  {
    months: z
      .number()
      .int()
      .min(3)
      .max(36)
      .optional()
      .describe("Months of history. Defaults to 8; use 18 for a 'past 1.5 years' question."),
    annotations: z
      .array(z.object({
        date: z.string().describe("YYYY-MM-DD"),
        label: z.string().describe("Short label, e.g. 'Rotterdam Marathon', 'flu', 'lactate test'"),
      }))
      .optional()
      .describe("Events to mark on the chart, from memory: races, illness, injuries, lab tests, big blocks."),
    heat_adjusted: z
      .boolean()
      .optional()
      .describe("Apply the heat prior (+0.2% EF per °C above 10°C, from marathon race data, not calibrated on this athlete). Default false. The default summary already prints how much the prior would move now-vs-peak; turn this on only when the athlete wants the adjusted series, and then always call the numbers heat-adjusted. Nothing is applied in the cold."),
  },
  async ({ months, annotations, heat_adjusted }) => {
    try {
      const result = await generateAerobicChart(months ?? 8, annotations ?? [], heat_adjusted ?? false);
      if (result.runCount === 0) {
        return toolResult(result.summary);
      }
      return toolResult(`${result.summary}\n\nChart saved to: ${result.outputPath}`);
    } catch (error) {
      return toolError(error);
    }
  }
);
