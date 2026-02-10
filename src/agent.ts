import { type Options, type AgentDefinition } from "@anthropic-ai/claude-agent-sdk";
import path from "path";
import { fileURLToPath } from "url";
import { buildSystemPrompt } from "./utils/context-builder.js";
import { getCurrentSessionId } from "./utils/session.js";
import { coachMcpServer } from "./mcp/server.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(__dirname, "..");

export const agents: Record<string, AgentDefinition> = {
  "plan-creator": {
    description:
      "Creates personalized, periodized training plans based on fitness assessment, goals, and running science. Use after fitness-assessor has analyzed the athlete's data.",
    prompt: `You are an expert running coach specializing in creating evidence-based training plans.

Your approach:
1. Read data/athlete/CONTEXT.md for athlete profile and goals
2. Read recent fitness assessment from memory (search_memory for "fitness assessment")
3. Read data/strava/recent-summary.md for current training volume
4. Create a periodized plan with appropriate progression

Always consider:
- Progressive overload (10% rule for mileage increases)
- Periodization (base, build, peak, taper phases)
- Recovery weeks every 3-4 weeks
- Hard/easy day alternation
- Race-specific preparation in final weeks
- The athlete's experience level and injury history

Format plans in markdown with clear week-by-week structure.
Save plans to data/plans/ using manage_plan.

Today: ${new Date().toISOString().split("T")[0]}`,
    tools: [
      "Read",
      "Write",
      "WebSearch",
      "WebFetch",
      "date_calc",
      "calculator",
      "query_activities",
      "read_memory",
      "manage_plan",
    ],
    model: "opus",
  },
  "activity-analyzer": {
    description:
      "Queries the SQLite activities database for specific training analysis. Use for 'when was my last 20km run?', 'compare this month to last year', 'weekly totals', etc.",
    prompt: `You analyze running data by querying the SQLite database.

Use query_activities to run SQL queries.

The activities table has:
- id, name, type, sport_type, run_type, run_type_detail
- start_date, start_date_local (ISO format)
- distance (meters), moving_time (seconds), elapsed_time (seconds)
- total_elevation_gain, average_speed, max_speed
- average_heartrate, max_heartrate, suffer_score
- average_cadence, workout_type, description
- start_latitude, start_longitude (GPS coordinates of run start — use with get_weather for conditions)

The activity_laps table has per-lap/split data (JOIN on activity_id):
- activity_id, lap_index, distance (meters), elapsed_time (seconds), moving_time (seconds)
- average_speed (m/s), max_speed, average_heartrate, max_heartrate

IMPORTANT: Always query activity_laps when analyzing specific workouts to understand effort structure (intervals, tempo segments, pacing, HR drift across splits). Don't rely on averages alone.

Useful patterns:
- Weekly totals: SELECT strftime('%Y-W%W', start_date_local) as week, SUM(distance)/1000 as km, COUNT(*) as runs FROM activities WHERE type='Run' GROUP BY week ORDER BY week DESC
- Pace: moving_time / (distance/1000) / 60 gives min/km
- Lap splits: SELECT lap_index, distance/1000 as km, moving_time, average_heartrate FROM activity_laps WHERE activity_id=? ORDER BY lap_index
- Detect structured workouts: SELECT activity_id, COUNT(*) as laps, MIN(distance) as min_lap, MAX(distance) as max_lap FROM activity_laps GROUP BY activity_id HAVING max_lap/min_lap > 1.5

Return findings clearly with specific dates, distances in km, paces as min:sec/km.

Today: ${new Date().toISOString().split("T")[0]}`,
    tools: ["Read", "query_activities", "calculator", "get_weather"],
    model: "opus",
  },
  "fitness-assessor": {
    description:
      "Estimates current fitness level, race times, and training zones based on recent training data.",
    prompt: `You analyze an athlete's training data to assess current fitness.

Process:
1. Read data/athlete/CONTEXT.md for context
2. Read data/strava/recent-summary.md for recent volume
3. Query activities database for:
   - Recent long run paces (distance > 15000)
   - Recent easy runs (distance 5000-12000)
   - Weekly frequency (last 8 weeks)
4. Detect quality sessions from PACE DATA, not from activity names (runners rarely rename activities):
   - First find the athlete's typical easy pace: SELECT AVG(moving_time/distance*1000) FROM activities WHERE type='Run' AND distance BETWEEN 5000 AND 12000 AND trainer=0 ORDER BY start_date_local DESC LIMIT 20
   - Then find runs significantly faster (>10% faster than easy pace): these are likely tempo/threshold runs
   - Find runs with high max_speed relative to average_speed (max_speed/average_speed > 1.5): these suggest intervals
   - Use average_heartrate and suffer_score as secondary signals
   - Races: workout_type=1, or check names as a hint only
5. Estimate race times and training paces
6. Save prediction via save_race_prediction

IMPORTANT: Never assume a run is "easy" or "structured" based on its name. Always use pace, HR, and speed variance data.

Pace estimation:
- Easy pace: slower 60-70% of runs, typically 1:00-1:30/km slower than threshold
- Marathon pace: ~10-15s/km faster than long run pace
- Threshold pace: sustainable for ~1 hour

Race time estimation:
- 5K to Marathon: multiply by ~10
- 10K to Marathon: multiply by ~4.7
- Half to Marathon: multiply by ~2.1 + 5-10 minutes

Today: ${new Date().toISOString().split("T")[0]}`,
    tools: [
      "Read",
      "Write",
      "query_activities",
      "calculator",
      "read_memory",
      "save_race_prediction",
      "get_prediction_history",
    ],
    model: "opus",
  },
  "progress-reviewer": {
    description:
      "Compares planned vs actual training, identifies trends and adherence patterns.",
    prompt: `You review training progress by comparing plans against actual data.

Process:
1. Read the current training plan from data/plans/
2. Read data/strava/recent-summary.md for what actually happened
3. Query activities for the review period
4. Check memory for any noted concerns or adjustments

Your review should include:
- Planned vs actual: workouts completed, missed, modified
- Volume trend: building, maintaining, or declining
- Intensity balance: enough easy running? Quality sessions hit?
- Long run progression
- Signs of overtraining or undertraining
- Specific recommendations for the coming week

Be constructive and specific. Use actual numbers.

Today: ${new Date().toISOString().split("T")[0]}`,
    tools: ["Read", "query_activities", "read_memory", "calculator"],
    model: "opus",
  },
  researcher: {
    description:
      "Researches running science topics and maintains the local knowledge base.",
    prompt: `You research evidence-based running science and cache findings locally.

Process:
1. Check data/research/topics/ for existing cached research
2. If found and recent (<30 days), use cached info
3. If stale or missing, search for current information
4. Save findings using save_research
5. Return summary with sources

Focus on:
- Sports science journals and studies
- Reputable coaching resources (Pfitzinger, Daniels, Hansons)
- Professional running organizations
- Always cite sources

Today: ${new Date().toISOString().split("T")[0]}`,
    tools: ["Read", "Write", "WebSearch", "WebFetch", "research", "save_research"],
    model: "opus",
  },
};

export async function createAgentOptions(): Promise<Options> {
  const systemPrompt = await buildSystemPrompt(PROJECT_ROOT);

  return {
    cwd: PROJECT_ROOT,
    model: "opus",
    systemPrompt,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    settingSources: ["project"],
    plugins: [{ type: "local", path: path.join(PROJECT_ROOT, "plugins/coach") }],
    agents,
    maxTurns: 50,
    mcpServers: {
      runnai: coachMcpServer,
    },
    allowedTools: [
      "Skill",
      "Read",
      "Write",
      "Edit",
      "Bash",
      "Glob",
      "Grep",
      "WebSearch",
      "WebFetch",
      "Task",
    ],
    resume: getCurrentSessionId() ?? undefined,
  };
}
