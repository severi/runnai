import * as fs from "fs/promises";
import * as path from "path";
import { getDataDir } from "./paths.js";

/**
 * Goal hierarchy store — data/athlete/goals.json.
 *
 * Three tiers: one north star (the lifetime "why"), horizon goals (multi-year
 * aims), and event goals (a race, a test). The store is deliberately loose:
 * links are optional, any status transition is allowed, and every change is
 * appended to the goal's history so the coach can see how the picture evolved.
 * Goals guide the coach's judgment; they never block anything.
 */

export type GoalTier = "northstar" | "horizon" | "event";
export type GoalStatus = "aspiration" | "committed" | "active" | "achieved" | "parked" | "abandoned";

export interface GoalTarget {
  date?: string;
  window?: string;
  metric?: string;
}

export interface CoachAssessment {
  date: string;
  feasibility: string;
  confidence: string;
  summary: string;
  detailRef?: string;
}

export type GoalHistoryEntry =
  | { date: string; kind: "created"; note?: string }
  | { date: string; kind: "status"; from: GoalStatus; to: GoalStatus; note?: string }
  | { date: string; kind: "restated"; from: string; to: string; note?: string }
  | { date: string; kind: "assessed"; note: string }
  | { date: string; kind: "updated"; note: string };

export interface Goal {
  id: string;
  tier: GoalTier;
  statement: string;
  why?: string;
  status: GoalStatus;
  parentId?: string;
  created?: string;
  target?: GoalTarget;
  planSlug?: string;
  athleteNotes?: string;
  coachAssessment?: CoachAssessment;
  history: GoalHistoryEntry[];
}

export interface GoalsFile {
  version: 1;
  goals: Goal[];
}

export type NewGoal = Omit<Goal, "history" | "created" | "id"> & { id?: string };
export type GoalPatch = Partial<Pick<Goal, "statement" | "why" | "parentId" | "target" | "planSlug" | "athleteNotes">>;

const LIVE: GoalStatus[] = ["committed", "active"];
const HIDDEN: GoalStatus[] = ["achieved", "abandoned"];

export function getGoalsFile(): string {
  return path.join(getDataDir(), "athlete/goals.json");
}

export async function loadGoals(): Promise<GoalsFile> {
  try {
    const raw = await fs.readFile(getGoalsFile(), "utf-8");
    const parsed = JSON.parse(raw) as GoalsFile;
    return { version: 1, goals: Array.isArray(parsed.goals) ? parsed.goals : [] };
  } catch {
    return { version: 1, goals: [] };
  }
}

async function saveGoals(store: GoalsFile): Promise<void> {
  const file = getGoalsFile();
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(store, null, 2) + "\n", "utf-8");
  await fs.rename(tmp, file);
}

export function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "goal";
}

function requireGoal(store: GoalsFile, id: string): Goal {
  const goal = store.goals.find((g) => g.id === id);
  if (!goal) throw new Error(`No goal with id '${id}'. Use manage_goals(action: 'list') to see ids.`);
  return goal;
}

function checkParent(store: GoalsFile, parentId: string | undefined, selfId?: string): void {
  if (parentId === undefined) return;
  if (parentId === selfId) throw new Error("A goal cannot be its own parent.");
  if (!store.goals.some((g) => g.id === parentId)) throw new Error(`parentId '${parentId}' does not match any goal.`);
}

export async function addGoal(input: NewGoal, date: string, note?: string): Promise<Goal> {
  const store = await loadGoals();
  const id = input.id ?? slugify(input.statement);
  if (store.goals.some((g) => g.id === id)) throw new Error(`A goal with id '${id}' already exists.`);
  checkParent(store, input.parentId);
  const goal: Goal = { ...input, id, created: date, history: [{ date, kind: "created", ...(note ? { note } : {}) }] };
  store.goals.push(goal);
  await saveGoals(store);
  return goal;
}

export async function updateGoal(id: string, patch: GoalPatch, date: string, note?: string): Promise<Goal> {
  const store = await loadGoals();
  const goal = requireGoal(store, id);
  checkParent(store, patch.parentId, id);
  const changed: string[] = [];
  if (patch.statement !== undefined && patch.statement !== goal.statement) {
    goal.history.push({ date, kind: "restated", from: goal.statement, to: patch.statement, ...(note ? { note } : {}) });
    goal.statement = patch.statement;
  }
  for (const key of ["why", "parentId", "target", "planSlug", "athleteNotes"] as const) {
    if (patch[key] !== undefined) {
      (goal as unknown as Record<string, unknown>)[key] = patch[key];
      changed.push(key);
    }
  }
  if (changed.length > 0) {
    goal.history.push({ date, kind: "updated", note: `${changed.join(", ")} updated${note ? ` — ${note}` : ""}` });
  }
  await saveGoals(store);
  return goal;
}

export async function setGoalStatus(id: string, status: GoalStatus, date: string, note?: string): Promise<Goal> {
  const store = await loadGoals();
  const goal = requireGoal(store, id);
  if (goal.status !== status) {
    goal.history.push({ date, kind: "status", from: goal.status, to: status, ...(note ? { note } : {}) });
    goal.status = status;
  }
  await saveGoals(store);
  return goal;
}

export async function assessGoal(id: string, assessment: CoachAssessment): Promise<Goal> {
  const store = await loadGoals();
  const goal = requireGoal(store, id);
  goal.coachAssessment = assessment;
  goal.history.push({ date: assessment.date, kind: "assessed", note: `${assessment.feasibility} (${assessment.confidence}): ${assessment.summary}` });
  await saveGoals(store);
  return goal;
}

/** Observations for the coach to raise at a natural moment. Never blockers. */
export function findTensions(store: GoalsFile): string[] {
  const out: string[] = [];
  const liveHorizon = store.goals.filter((g) => g.tier === "horizon" && LIVE.includes(g.status));
  for (let i = 0; i < liveHorizon.length; i++) {
    for (let j = i + 1; j < liveHorizon.length; j++) {
      out.push(`${liveHorizon[i].statement} and ${liveHorizon[j].statement} are both live horizon goals — worth naming which leads this season.`);
    }
  }
  for (const g of store.goals) {
    if (g.tier !== "event" || !LIVE.includes(g.status) || !g.parentId) continue;
    const parent = store.goals.find((p) => p.id === g.parentId);
    if (parent && (parent.status === "parked" || parent.status === "abandoned")) {
      out.push(`${g.statement} is ${g.status} but the goal it serves (${parent.statement}) is ${parent.status}.`);
    }
  }
  return out;
}

function describeGoal(store: GoalsFile, g: Goal): string {
  const parts = [`- [${g.status}] ${g.statement}`];
  if (g.target?.date) parts.push(g.target.date);
  if (g.target?.window) parts.push(g.target.window);
  if (g.target?.metric) parts.push(g.target.metric);
  if (g.parentId) {
    const parent = store.goals.find((p) => p.id === g.parentId);
    if (parent && parent.tier !== "northstar") parts.push(`serves: ${parent.statement}`);
  }
  if (g.planSlug) parts.push(`plan: ${g.planSlug}`);
  if (g.coachAssessment) {
    const a = g.coachAssessment;
    parts.push(`coach: ${a.feasibility} (${a.confidence}, ${a.date})`);
    if (a.detailRef) parts.push(`detail: ${a.detailRef}`);
  } else if (g.tier === "horizon") {
    parts.push("coach: not assessed");
  }
  return parts.join(" · ");
}

/** Compact block for the system prompt. Empty string when there are no goals. */
export function renderGoalsBlock(store: GoalsFile): string {
  const visible = store.goals.filter((g) => !HIDDEN.includes(g.status));
  if (visible.length === 0) return "";
  const lines: string[] = [];
  const north = visible.find((g) => g.tier === "northstar");
  lines.push(north ? `North star: ${north.statement}${north.why ? ` — ${north.why}` : ""}` : "North star: not yet set (offer /goals when the moment is right)");
  const horizon = visible.filter((g) => g.tier === "horizon" && g.status !== "parked");
  const events = visible.filter((g) => g.tier === "event" && g.status !== "parked");
  const parked = visible.filter((g) => g.status === "parked");
  if (horizon.length) lines.push("Horizon:", ...horizon.map((g) => describeGoal(store, g)));
  if (events.length) lines.push("Events:", ...events.map((g) => describeGoal(store, g)));
  if (parked.length) lines.push(`Parked: ${parked.map((g) => g.statement).join("; ")}`);
  const tensions = findTensions(store);
  if (tensions.length) lines.push("Tensions:", ...tensions.map((t) => `- ${t}`));
  return lines.join("\n");
}
