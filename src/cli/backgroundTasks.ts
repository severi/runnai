import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

/**
 * Background task tracking for the live region.
 *
 * The foreground tools bar (useToolTracker) keys on tool_use ids and drops a
 * tool the moment its tool_result arrives. When the SDK backgrounds an Agent
 * call, that result arrives immediately ("Async agent launched successfully"),
 * so the agent vanished from the UI while it kept working for minutes —
 * and its progress events between turns were discarded entirely. This module
 * tracks tasks by task_id, independent of turn state, and is a pure reducer so
 * App.tsx can apply it to every SDK message regardless of whether a turn is open.
 */

export interface BackgroundTask {
  task_id: string;
  description: string;
  subagent_type?: string;
  summary?: string;
}

export interface BackgroundTasks {
  /** Live background tasks, in start order. */
  tasks: BackgroundTask[];
  /**
   * Metadata seen on task_started, kept for every task (foreground too) so a
   * task that is later backgrounded or settles can be labelled. task_started
   * precedes the level signal, so it can't be attached to `tasks` directly.
   */
  known: Record<string, { description: string; subagent_type?: string }>;
}

export function emptyBackgroundTasks(): BackgroundTasks {
  return { tasks: [], known: {} };
}

export interface TaskEventResult {
  state: BackgroundTasks;
  /** A line for the transcript when a task settles. */
  notice?: string;
}

function taskLabel(subagentType: string | undefined): string {
  return subagentType ?? "task";
}

export function applyTaskEvent(state: BackgroundTasks, message: SDKMessage): TaskEventResult {
  if (message.type !== "system" || !("subtype" in message)) return { state };
  const sys = message as SDKMessage & {
    subtype: string;
    task_id?: string;
    description?: string;
    subagent_type?: string;
    summary?: string;
    status?: string;
    tasks?: { task_id: string; task_type: string; description: string }[];
  };

  switch (sys.subtype) {
    case "task_started": {
      if (!sys.task_id) return { state };
      const known = { ...state.known, [sys.task_id]: { description: sys.description ?? "", subagent_type: sys.subagent_type } };
      const tasks = state.tasks.map((t) =>
        t.task_id === sys.task_id
          ? { ...t, description: sys.description ?? t.description, subagent_type: sys.subagent_type ?? t.subagent_type }
          : t,
      );
      return { state: { tasks, known } };
    }

    case "background_tasks_changed": {
      // Level signal with replace semantics; keep summaries for retained ids.
      const prev = new Map(state.tasks.map((t) => [t.task_id, t]));
      const tasks = (sys.tasks ?? []).map((t) => ({
        task_id: t.task_id,
        description: t.description || state.known[t.task_id]?.description || "",
        subagent_type: prev.get(t.task_id)?.subagent_type ?? state.known[t.task_id]?.subagent_type,
        summary: prev.get(t.task_id)?.summary,
      }));
      return { state: { ...state, tasks } };
    }

    case "task_progress": {
      if (!sys.task_id) return { state };
      const idx = state.tasks.findIndex((t) => t.task_id === sys.task_id);
      const base: BackgroundTask = idx >= 0
        ? state.tasks[idx]
        : { task_id: sys.task_id, description: sys.description ?? "", subagent_type: state.known[sys.task_id]?.subagent_type };
      const updated: BackgroundTask = {
        ...base,
        description: base.description || sys.description || state.known[sys.task_id]?.description || "",
        subagent_type: sys.subagent_type ?? base.subagent_type,
        summary: sys.summary ?? base.summary,
      };
      const tasks = idx >= 0
        ? state.tasks.map((t, i) => (i === idx ? updated : t))
        : [...state.tasks, updated];
      return { state: { ...state, tasks } };
    }

    case "task_notification": {
      if (!sys.task_id) return { state };
      const task = state.tasks.find((t) => t.task_id === sys.task_id);
      const tasks = state.tasks.filter((t) => t.task_id !== sys.task_id);
      const { [sys.task_id]: dropped, ...known } = state.known;
      const label = taskLabel(task?.subagent_type ?? dropped?.subagent_type);
      const verb = sys.status === "completed" ? "finished" : sys.status === "failed" ? "failed" : "stopped";
      const notice = `Background ${label} ${verb}${sys.summary ? `: ${sys.summary}` : ""}`;
      return { state: { tasks, known }, notice };
    }

    default:
      return { state };
  }
}
