import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ToolTracker } from "./hooks/useToolTracker.js";
import { formatToolInput } from "./hooks/useToolTracker.js";
import type { Message } from "./commands.js";
import type { ExchangeUsage } from "../utils/usage-tracker.js";
import { recordExchange, formatExchangeLine } from "../utils/usage-tracker.js";
import { logEvent, setLogSessionId } from "../utils/logger.js";
import { setSessionId } from "../utils/session.js";

let turnStartTime: number | null = null;
let lastUserUuid: string | null = null;
// Correlate task_progress events back to the Task tool_use that started them
const taskToToolUse = new Map<string, string>();

export interface ContextUsage {
  /** Tokens read from the cache (the bulk of conversation history) */
  cacheReadTokens: number;
  /** Tokens newly written to the cache this turn */
  cacheCreationTokens: number;
  /** Uncached input tokens (the user message) */
  inputTokens: number;
  /** Output tokens generated this turn */
  outputTokens: number;
}

export interface MessageHandlerCallbacks {
  addMessage: (role: Message["role"], content: string) => void;
  setStreamingText: (text: string | null) => void;
  toolTracker: ToolTracker;
  onRequesting?: () => void;
  onUsage?: (usage: ContextUsage) => void;
}

export interface MessageHandlerState {
  currentResponse: string;
  hadToolCall: boolean;
}

export function handleSdkMessage(
  message: SDKMessage,
  callbacks: MessageHandlerCallbacks,
  state: MessageHandlerState,
): void {
  const { addMessage, setStreamingText, toolTracker, onRequesting, onUsage } = callbacks;

  switch (message.type) {
    case "system": {
      if (!("subtype" in message)) break;
      const sys = message as SDKMessage & {
        subtype: string;
        model?: string;
        session_id?: string;
        status?: string;
        task_id?: string;
        tool_use_id?: string;
        summary?: string;
      };
      if (sys.subtype === "init") {
        logEvent("system", {
          subtype: "init",
          model: sys.model,
          session_id: sys.session_id,
        });
        if (sys.session_id) {
          setLogSessionId(sys.session_id);
          setSessionId(sys.session_id);
        }
        addMessage("debug", `Model: ${sys.model}`);
      } else if (sys.subtype === "status") {
        if (sys.status === "requesting") onRequesting?.();
      } else if (sys.subtype === "task_started") {
        if (sys.task_id && sys.tool_use_id) taskToToolUse.set(sys.task_id, sys.tool_use_id);
      } else if (sys.subtype === "task_progress") {
        if (sys.summary) {
          const toolUseId = sys.tool_use_id ?? (sys.task_id ? taskToToolUse.get(sys.task_id) : undefined);
          if (toolUseId) toolTracker.updateSummary(toolUseId, sys.summary);
          logEvent("system", {
            subtype: "task_progress",
            task_id: sys.task_id,
            tool_use_id: toolUseId,
            summary: sys.summary,
          });
        }
      }
      break;
    }

    case "assistant": {
      // Track turn start
      if (turnStartTime === null) {
        turnStartTime = Date.now();
      }

      // Log the full raw API message (includes content blocks + usage)
      logEvent("assistant", {
        message: message.message,
      }, lastUserUuid);

      // Per-message usage = the actual input size for this single inference,
      // i.e. the real context size at this moment. Use this (NOT the aggregated
      // modelUsage on the result event, which sums cacheRead across sub-calls
      // in a turn and inflates numbers).
      const msgUsage = (message.message as any).usage as
        | {
            input_tokens?: number;
            cache_read_input_tokens?: number;
            cache_creation_input_tokens?: number;
            output_tokens?: number;
          }
        | undefined;
      if (msgUsage && onUsage) {
        onUsage({
          inputTokens: msgUsage.input_tokens ?? 0,
          cacheReadTokens: msgUsage.cache_read_input_tokens ?? 0,
          cacheCreationTokens: msgUsage.cache_creation_input_tokens ?? 0,
          outputTokens: msgUsage.output_tokens ?? 0,
        });
      }

      for (const block of message.message.content) {
        if (block.type === "text") {
          if (state.hadToolCall) {
            state.hadToolCall = false;
          }

          state.currentResponse += block.text;
          setStreamingText(state.currentResponse);
        } else if (block.type === "tool_use") {
          const toolUseId = (block as any).id as string || `fallback-${Date.now()}`;
          // Flush accumulated text as a proper message
          if (state.currentResponse.trim()) {
            addMessage("assistant", state.currentResponse);
            state.currentResponse = "";
            setStreamingText(null);
          }
          state.hadToolCall = true;

          toolTracker.startTool(toolUseId, block.name, block.input as Record<string, unknown>);

          const toolName = block.name.replace("mcp__runnai__", "");
          const inputStr = formatToolInput(block.input as Record<string, unknown>);
          addMessage("tool", `→ ${toolName}(${inputStr})`);
        }
      }
      break;
    }

    case "user":
      if (message.tool_use_result !== undefined) {
        const result = message.tool_use_result as unknown;
        const resultStr = typeof result === "string" ? result : JSON.stringify(result);
        const isError = typeof result === "object" && result !== null &&
          "isError" in result && (result as Record<string, unknown>).isError === true;

        const toolUseId = extractToolUseId(message);
        const { tool, durationMs } = toolTracker.completeTool(toolUseId ?? "");

        // Log as raw user message with tool_result content
        logEvent("user", {
          message: (message as any).message ?? {
            role: "user",
            content: [{
              type: "tool_result",
              tool_use_id: toolUseId,
              content: resultStr,
              is_error: isError,
            }],
          },
          duration_ms: durationMs || null,
          tool_name: tool?.name ?? null,
        });

        if (tool) {
          const elapsed = (durationMs / 1000).toFixed(1);
          const prefix = isError ? "✗" : "✓";
          const label = `${prefix} [${tool.index}] ${tool.name}${tool.keyArg ? `: ${tool.keyArg}` : ""}`;
          addMessage("tool_activity", `${label}|||${elapsed}s`);
        }

        if (isError) {
          const errorStr = typeof result === "string"
            ? result
            : JSON.stringify(result, null, 2);
          addMessage("error", `Tool error: ${errorStr.slice(0, 500)}`);
        } else {
          const resultStr2 = typeof result === "string"
            ? result.slice(0, 200) + (result.length > 200 ? "..." : "")
            : JSON.stringify(result).slice(0, 200);
          addMessage("tool", `← ${resultStr2}`);
        }
      }
      break;

    case "tool_progress":
      break;

    case "result": {
      // Emit turn_duration
      if (turnStartTime !== null) {
        logEvent("system", {
          subtype: "turn_duration",
          durationMs: Date.now() - turnStartTime,
        });
        turnStartTime = null;
      }

      if (message.session_id) {
        setSessionId(message.session_id);
      }

      const res = message as SDKMessage & { subtype?: string; terminal_reason?: string };
      const subtype = res.subtype;
      if (res.terminal_reason === "aborted_tools") {
        addMessage("system", "Interrupted.");
      } else if (subtype && subtype !== "success") {
        const errorMessages: Record<string, string> = {
          error_max_turns: "Reached maximum turns limit. Try breaking the task into smaller steps.",
          error_during_execution: "An error occurred during execution.",
          error_tool_use: "A tool use error occurred.",
        };
        addMessage("system", errorMessages[subtype] || `Session ended with: ${subtype}`);
      }

      let inputTokens = 0;
      let outputTokens = 0;
      let cacheReadTokens = 0;
      let cacheCreationTokens = 0;
      const modelUsage = (message as any).modelUsage as Record<string, { inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number; costUSD: number }> | undefined;
      if (modelUsage) {
        for (const usage of Object.values(modelUsage)) {
          inputTokens += usage.inputTokens;
          outputTokens += usage.outputTokens;
          cacheReadTokens += usage.cacheReadInputTokens;
          cacheCreationTokens += usage.cacheCreationInputTokens;
        }
      }

      const exchange: ExchangeUsage = {
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheCreationTokens,
        costUsd: message.total_cost_usd,
        durationMs: message.duration_ms,
        numTurns: message.num_turns,
      };
      logEvent("system", {
        subtype: "result",
        ...exchange,
      });
      recordExchange(exchange);
      addMessage("status", formatExchangeLine(exchange));
      // NOTE: onUsage is NOT called here. The aggregated modelUsage on a
      // result event sums cacheRead/cacheCreation across all sub-calls in a
      // multi-tool turn, which inflates numbers (4 sub-calls × ~140k each =
      // ~560k reported even when actual context never exceeded ~145k).
      // The context bar updates from per-assistant-message usage instead
      // (see the assistant case above).
      break;
    }
  }
}

function extractToolUseId(message: SDKMessage): string | null {
  const content = (message as any).message?.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (typeof block === "object" && block !== null && block.type === "tool_result" && block.tool_use_id) {
        return block.tool_use_id;
      }
    }
  }
  return null;
}

/** Set the parent UUID for linking assistant events to the user message that triggered them. */
export function setLastUserUuid(uuid: string): void {
  lastUserUuid = uuid;
}

/** Reset turn tracking (call before each new user turn). */
export function resetTurn(): void {
  turnStartTime = null;
  taskToToolUse.clear();
}
