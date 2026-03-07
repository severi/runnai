import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { savePrediction, getPredictionHistory } from "../utils/activities-db.js";
import type { RacePrediction } from "../types/index.js";
import { formatTime, toDateString, toolResult, toolError } from "../utils/format.js";

export const saveRacePredictionTool = tool(
  "save_race_prediction",
  "Store a race prediction with date and basis to SQLite for tracking prediction evolution over time.",
  {
    race_distance: z.string().describe("Race distance (e.g., 'Marathon', '5K', 'Ultra 50K')"),
    predicted_time: z.number().describe("Predicted time in seconds"),
    confidence: z.enum(["low", "medium", "high"]).describe("Confidence level"),
    basis: z.string().describe("What data this prediction was based on"),
  },
  async ({ race_distance, predicted_time, confidence, basis }) => {
    try {
      const prediction: RacePrediction = {
        race_distance,
        predicted_time,
        confidence,
        basis,
        predicted_at: toDateString(),
      };

      savePrediction(prediction);

      return toolResult(`Saved ${race_distance} prediction: ${formatTime(predicted_time)} (${confidence} confidence)\nBasis: ${basis}`);
    } catch (error) {
      return toolError(error);
    }
  }
);

export const getPredictionHistoryTool = tool(
  "get_prediction_history",
  "Retrieve race prediction evolution over time to show how estimates have changed.",
  {
    race_distance: z.string().optional().describe("Filter by race distance. Omit for all distances."),
  },
  async ({ race_distance }) => {
    try {
      const predictions = getPredictionHistory(race_distance);

      if (predictions.length === 0) {
        return toolResult(race_distance
          ? `No predictions found for ${race_distance}.`
          : "No predictions saved yet.");
      }

      let output = "# Race Prediction History\n\n";

      // Group by distance
      const grouped = new Map<string, RacePrediction[]>();
      for (const p of predictions) {
        if (!grouped.has(p.race_distance)) {
          grouped.set(p.race_distance, []);
        }
        grouped.get(p.race_distance)!.push(p);
      }

      for (const [dist, preds] of grouped) {
        output += `## ${dist}\n\n`;
        output += `| Date | Predicted Time | Confidence | Basis |\n`;
        output += `|------|---------------|------------|-------|\n`;

        for (const p of preds) {
          output += `| ${p.predicted_at} | ${formatTime(p.predicted_time)} | ${p.confidence} | ${p.basis} |\n`;
        }

        // Show trend
        if (preds.length >= 2) {
          const latest = preds[0].predicted_time;
          const earliest = preds[preds.length - 1].predicted_time;
          const diff = earliest - latest;
          if (diff > 0) {
            output += `\nTrend: Improved by ${Math.round(diff)}s since first prediction.\n`;
          } else if (diff < 0) {
            output += `\nTrend: Slower by ${Math.round(Math.abs(diff))}s since first prediction.\n`;
          }
        }

        output += "\n";
      }

      return toolResult(output);
    } catch (error) {
      return toolError(error);
    }
  }
);
