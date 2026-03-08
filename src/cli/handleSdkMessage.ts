import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ToolTracker } from "./hooks/useToolTracker.js";
import { formatToolInput } from "./hooks/useToolTracker.js";
import type { Message } from "./commands.js";
import type { ExchangeUsage } from "../utils/usage-tracker.js";
import { recordExchange, formatExchangeLine } from "../utils/usage-tracker.js";
import { logEvent, saveToolResult, saveSystemPrompt, updateMeta } from "../utils/logger.js";
import { setSessionId } from "../utils/session.js";

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

export interface MessageHandlerCallbacks {
  addMessage: (role: Message["role"], content: string) => void;
  setStreamingText: (text: string | null) => void;
  toolTracker: ToolTracker;
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
  const { addMessage, setStreamingText, toolTracker } = callbacks;

  logEvent("sdk_message", {
    sdk_type: message.type,
    ...("subtype" in message ? { subtype: (message as any).subtype } : {}),
  });

  switch (message.type) {
    case "system":
      if ("subtype" in message && message.subtype === "init") {
        const initMsg = message as SDKMessage & { model: string; session_id?: string };
        logEvent("system_init", {
          model: initMsg.model,
          session_id: initMsg.session_id,
        });
        updateMeta({ model: initMsg.model, session_id: initMsg.session_id });
        addMessage("debug", `Model: ${initMsg.model}`);
        if (initMsg.session_id) {
          setSessionId(initMsg.session_id);
        }
      }
      break;

    case "assistant":
      for (const block of message.message.content) {
        if (block.type === "text") {
          if (state.hadToolCall) {
            state.hadToolCall = false;
          }

          state.currentResponse += block.text;
          setStreamingText(state.currentResponse);
          logEvent("assistant_text", { text: block.text });
        } else if (block.type === "tool_use") {
          const toolUseId = (block as any).id as string || `fallback-${Date.now()}`;
          logEvent("tool_use", {
            tool: block.name,
            tool_use_id: toolUseId,
            input: block.input,
          });
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

    case "user":
      if (message.tool_use_result !== undefined) {
        const result = message.tool_use_result as unknown;
        const resultStr = typeof result === "string" ? result : JSON.stringify(result);
        const isError = typeof result === "object" && result !== null &&
          "isError" in result && (result as Record<string, unknown>).isError === true;

        const toolUseId = extractToolUseId(message);
        const { tool, durationMs } = toolTracker.completeTool(toolUseId ?? "");

        const preview = resultStr.slice(0, 500);
        const fullResultFile = toolUseId ? saveToolResult(toolUseId, result) : null;
        logEvent("tool_result", {
          tool_use_id: toolUseId,
          tool_name: tool?.name ?? null,
          is_error: isError,
          duration_ms: durationMs || null,
          preview,
          ...(fullResultFile ? { full_result_file: fullResultFile } : {}),
          ...(resultStr.length <= 1024 ? { result: resultStr } : {}),
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
      if (message.session_id) {
        setSessionId(message.session_id);
      }

      const subtype = (message as any).subtype as string | undefined;
      if (subtype && subtype !== "success") {
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
      logEvent("result", {
        subtype,
        ...exchange,
      });
      recordExchange(exchange);
      addMessage("status", formatExchangeLine(exchange));
      break;
    }
  }
}
