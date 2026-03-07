import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { fetchActivityStream } from "../strava/client.js";
import { getActivityStreams, saveActivityStreams } from "../utils/activities-db.js";
import { toolResult, toolError } from "../utils/format.js";

const ALL_KEYS = ["time", "distance", "heartrate", "altitude", "grade_smooth", "cadence"] as const;

export const getActivityStreamsTool = tool(
  "get_activity_streams",
  "Get per-second stream data (HR, altitude, grade, cadence) for a specific activity. Returns cached data if available, otherwise fetches from Strava and caches. Use this for sub-lap analysis: hill sessions (segment by altitude to separate climb vs descent HR), tempo runs (HR drift), intervals (recovery patterns), pacing on hilly courses.",
  {
    activity_id: z.number().describe("Strava activity ID"),
    keys: z
      .array(z.enum(["time", "distance", "heartrate", "altitude", "grade_smooth", "cadence"]))
      .optional()
      .describe("Which streams to return. Default: all available. All streams are always cached regardless of this filter."),
  },
  async ({ activity_id, keys }) => {
    try {
      // Try cache first
      let streams = getActivityStreams(activity_id);

      // If not cached, fetch from Strava and cache
      if (!streams) {
        const fetched = await fetchActivityStream(activity_id);
        if (!fetched) {
          return toolResult(`No stream data available for activity ${activity_id}. The activity may not exist or may lack GPS/sensor data.`, true);
        }
        saveActivityStreams(activity_id, fetched);
        streams = fetched;
      }

      // Determine which streams are available and which are missing
      const available: string[] = [];
      const missing: string[] = [];
      for (const key of ALL_KEYS) {
        if (streams[key as keyof typeof streams]) {
          available.push(key);
        } else {
          missing.push(key);
        }
      }

      // Build output with optional key filtering
      const requestedKeys = keys || available;
      const outputStreams: Record<string, number[]> = {};
      for (const key of requestedKeys) {
        const data = streams[key as keyof typeof streams];
        if (data) {
          outputStreams[key] = data as number[];
        }
      }

      const result = {
        activity_id,
        data_points: streams.time.length,
        available,
        missing,
        streams: outputStreams,
      };

      return toolResult(JSON.stringify(result));
    } catch (error) {
      return toolError(error);
    }
  }
);
