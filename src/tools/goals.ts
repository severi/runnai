import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { toDateString, toolResult, toolError } from "../utils/format.js";
import {
  loadGoals,
  addGoal,
  updateGoal,
  setGoalStatus,
  assessGoal,
  findTensions,
  type Goal,
  type GoalsFile,
} from "../utils/goals.js";

const TIER = z.enum(["northstar", "horizon", "event"]);
const STATUS = z.enum(["aspiration", "committed", "active", "achieved", "parked", "abandoned"]);

function renderHistory(goal: Goal): string {
  return goal.history.map((h) => {
    const detail = "from" in h ? ` ${h.from} → ${h.to}` : "";
    return `    ${h.date} ${h.kind}${detail}${h.note ? ` — ${h.note}` : ""}`;
  }).join("\n");
}

function renderTree(store: GoalsFile, includeHistory: boolean): string {
  const byTier = (tier: Goal["tier"]) => store.goals.filter((g) => g.tier === tier);
  const line = (g: Goal) => {
    const bits = [`- [${g.status}] ${g.statement} (id: ${g.id})`];
    if (g.why) bits.push(`why: ${g.why}`);
    if (g.parentId) bits.push(`serves: ${g.parentId}`);
    if (g.target) bits.push(`target: ${[g.target.date, g.target.window, g.target.metric].filter(Boolean).join(" ")}`);
    if (g.planSlug) bits.push(`plan: ${g.planSlug}`);
    if (g.athleteNotes) bits.push(`athlete: ${g.athleteNotes}`);
    if (g.coachAssessment) bits.push(`coach (${g.coachAssessment.date}): ${g.coachAssessment.feasibility}, ${g.coachAssessment.confidence} — ${g.coachAssessment.summary}${g.coachAssessment.detailRef ? ` [${g.coachAssessment.detailRef}]` : ""}`);
    return bits.join("\n  ") + (includeHistory && goalHasHistory(g) ? `\n  history:\n${renderHistory(g)}` : "");
  };
  const sections: string[] = [];
  for (const [title, tier] of [["North star", "northstar"], ["Horizon", "horizon"], ["Events", "event"]] as const) {
    const goals = byTier(tier);
    if (goals.length) sections.push(`**${title}**\n${goals.map(line).join("\n")}`);
  }
  const tensions = findTensions(store);
  if (tensions.length) sections.push(`**Tensions (observations, not blockers)**\n${tensions.map((t) => `- ${t}`).join("\n")}`);
  return sections.join("\n\n");
}

function goalHasHistory(g: Goal): boolean {
  return Array.isArray(g.history) && g.history.length > 0;
}

export const manageGoalsTool = tool(
  "manage_goals",
  "The athlete's goal hierarchy (data/athlete/goals.json): one north star (the lifetime 'why'), horizon goals (multi-year aims like a marathon time or an ultra distance), and event goals (a specific race or test). Goals guide coaching judgment; they never restrict the athlete. Record a goal the moment it surfaces in conversation (as 'aspiration' unless the athlete says they are committed), restate it when the athlete's wording changes, park rather than delete, and write your own dated assessment with 'assess'. Every change is kept in the goal's history.",
  {
    action: z.enum(["list", "add", "update", "set_status", "assess"]).describe("Action to perform"),
    id: z.string().optional().describe("Goal id (slug). Required for update/set_status/assess. Optional for add (derived from the statement if omitted)."),
    tier: TIER.optional().describe("add: northstar | horizon | event"),
    statement: z.string().optional().describe("add/update: the goal in one line, in the athlete's own words where possible"),
    why: z.string().optional().describe("add/update: the athlete's motivation, in their words. Essential for the north star."),
    status: STATUS.optional().describe("add: initial status (default aspiration). set_status: the new status."),
    parentId: z.string().optional().describe("add/update: the goal this one serves (event → horizon or northstar; horizon → northstar). Optional."),
    targetDate: z.string().optional().describe("add/update: ISO date for an event goal"),
    targetWindow: z.string().optional().describe("add/update: rough window for a horizon goal, e.g. '2028-2029'"),
    targetMetric: z.string().optional().describe("add/update: what success looks like, e.g. 'sub 3:00', 'finish', 'by effort'"),
    planSlug: z.string().optional().describe("add/update: linked plan slug"),
    athleteNotes: z.string().optional().describe("add/update: what the athlete has said about it — current view"),
    note: z.string().optional().describe("add/update/set_status: why this change is being made. Goes into history."),
    confirmedByAthlete: z.boolean().optional().describe("add/update of a north star: set true only after reading the proposed wording back to the athlete and getting an explicit yes."),
    feasibility: z.string().optional().describe("assess: your verdict in a word or two — reachable, stretch, unlikely, unknown"),
    confidence: z.string().optional().describe("assess: low | medium | high"),
    summary: z.string().optional().describe("assess: one or two sentences — what it turns on"),
    detailRef: z.string().optional().describe("assess: memory file holding the full workup, e.g. memory/race-predictions/<goal>.md"),
    includeHistory: z.boolean().optional().describe("list: include each goal's history"),
  },
  async (input) => {
    const today = toDateString();
    try {
      switch (input.action) {
        case "list": {
          const store = await loadGoals();
          if (store.goals.length === 0) {
            return toolResult("No goals recorded yet. When the athlete mentions what they are aiming at — a race, a time, a distance, or the reason they run at all — record it here. For the north star, offer /goals for a proper conversation.");
          }
          return toolResult(renderTree(store, input.includeHistory ?? false));
        }
        case "add": {
          if (!input.tier || !input.statement) return toolResult("add requires tier and statement.", true);
          if (input.tier === "northstar" && !input.confirmedByAthlete) {
            return toolResult("The north star is the athlete's own answer to why they do this. Read the proposed statement and why back to them, get an explicit yes, then call add again with confirmedByAthlete: true. (Or suggest /goals for the fuller conversation.)", true);
          }
          const goal = await addGoal({
            id: input.id,
            tier: input.tier,
            statement: input.statement,
            why: input.why,
            status: input.status ?? "aspiration",
            parentId: input.parentId,
            target: target(input),
            planSlug: input.planSlug,
            athleteNotes: input.athleteNotes,
          }, today, input.note);
          return toolResult(`Recorded ${goal.tier} goal '${goal.id}' [${goal.status}]: ${goal.statement}`);
        }
        case "update": {
          if (!input.id) return toolResult("update requires id.", true);
          const store = await loadGoals();
          const existing = store.goals.find((g) => g.id === input.id);
          if (existing?.tier === "northstar" && (input.statement || input.why) && !input.confirmedByAthlete) {
            return toolResult("Changing the north star's wording: read the current and proposed versions back to the athlete, get an explicit yes, then call update again with confirmedByAthlete: true. The old wording stays in history.", true);
          }
          const goal = await updateGoal(input.id, {
            statement: input.statement,
            why: input.why,
            parentId: input.parentId,
            target: target(input),
            planSlug: input.planSlug,
            athleteNotes: input.athleteNotes,
          }, today, input.note);
          return toolResult(`Updated '${goal.id}': ${goal.statement}`);
        }
        case "set_status": {
          if (!input.id || !input.status) return toolResult("set_status requires id and status.", true);
          const goal = await setGoalStatus(input.id, input.status, today, input.note);
          let msg = `'${goal.id}' is now ${goal.status}.`;
          if (goal.status === "achieved" && goal.parentId) {
            const store = await loadGoals();
            const parent = store.goals.find((g) => g.id === goal.parentId);
            if (parent) msg += ` It served '${parent.statement}' (${parent.id}) — worth a fresh assess on that goal now that this result is in.`;
          }
          if (goal.status === "parked") msg += " Parked goals stay visible; ask about it at a natural moment (after a race, when planning a new block), not every session.";
          return toolResult(msg);
        }
        case "assess": {
          if (!input.id || !input.feasibility || !input.confidence || !input.summary) {
            return toolResult("assess requires id, feasibility, confidence and summary.", true);
          }
          const goal = await assessGoal(input.id, {
            date: today,
            feasibility: input.feasibility,
            confidence: input.confidence,
            summary: input.summary,
            ...(input.detailRef ? { detailRef: input.detailRef } : {}),
          });
          return toolResult(`Assessment recorded for '${goal.id}': ${input.feasibility} (${input.confidence}).`);
        }
        default:
          return toolResult(`Unknown action: ${String(input.action)}`, true);
      }
    } catch (error) {
      return toolError(error);
    }
  },
);

function target(input: { targetDate?: string; targetWindow?: string; targetMetric?: string }) {
  if (!input.targetDate && !input.targetWindow && !input.targetMetric) return undefined;
  return {
    ...(input.targetDate ? { date: input.targetDate } : {}),
    ...(input.targetWindow ? { window: input.targetWindow } : {}),
    ...(input.targetMetric ? { metric: input.targetMetric } : {}),
  };
}
