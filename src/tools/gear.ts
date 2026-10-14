import { tool } from "@anthropic-ai/claude-agent-sdk";
import { getGearWithUsage } from "../utils/activities-db.js";
import { toolResult, toolError } from "../utils/format.js";
import { dataSourceLabel } from "../utils/data-source.js";

export const getGearTool = tool(
  "get_gear",
  "Get the athlete's shoes (gear) with current mileage. `total_km` is the data source's authoritative lifetime distance (Strava or Garmin Connect) — use this for any 'how many km on these shoes' question; never quote a cached/remembered number. The *_in_db fields are usage attributed from synced runs (a lower bound). Refreshed on every sync.",
  {},
  async () => {
    try {
      const gear = getGearWithUsage();
      if (gear.length === 0) {
        return toolResult(
          `No gear found. Shoes sync from ${dataSourceLabel()} on the next sync_activities (the athlete must have shoes set up in their ${dataSourceLabel()} profile).`
        );
      }
      const lines = gear.map(g => {
        const totalKm = Math.round(g.distance_m / 1000);
        const flags = [g.is_primary ? "primary" : null, g.retired ? "retired" : null]
          .filter(Boolean)
          .join(", ");
        const flagStr = flags ? ` (${flags})` : "";
        const usage = g.last_used
          ? `last used ${g.last_used.slice(0, 10)}, ${g.runs_in_db} synced runs / ${g.km_in_db}km`
          : "no synced runs attributed yet";
        return `- ${g.name}${flagStr}: **${totalKm}km** total — ${usage}`;
      });
      const syncedAt = gear[0]?.synced_at?.slice(0, 10) ?? "unknown";
      return toolResult(
        `Shoes (total_km is ${dataSourceLabel()}'s authoritative lifetime mileage, synced ${syncedAt}):\n${lines.join("\n")}`
      );
    } catch (error) {
      return toolError(error);
    }
  }
);
