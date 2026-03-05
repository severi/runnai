import React, { useState, useEffect, useRef } from "react";
import { Box, Text, Static, useInput, useApp } from "ink";
import { TextInput } from "./components/TextInput.js";
import Fuse from "fuse.js";
import * as fs from "fs/promises";
import * as path from "path";
import { query, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { createAgentOptions } from "../agent.js";
import { getDataDir } from "../utils/paths.js";
import { setSessionId, resetSession, getCurrentSessionId, loadPersistedSession, saveSession, clearPersistedSession, appendChatMessage, loadChatHistory, clearChatHistory } from "../utils/session.js";
import { detectAndReadFiles, buildContentBlocks, type FileAttachment } from "../utils/file-attachments.js";
import { recordExchange, resetUsage, formatExchangeLine, type ExchangeUsage } from "../utils/usage-tracker.js";
import { log } from "../utils/logger.js";
import { commands, getCommandByName, type Command, type CommandContext, type Message } from "./commands.js";
import { ChatBubble } from "./components/ChatBubble.js";
import { QuestionPrompt, type AskQuestion } from "./components/QuestionPrompt.js";
import type { PermissionResult } from "@anthropic-ai/claude-agent-sdk";

const CONTEXT_FILE = path.join(getDataDir(), "athlete/CONTEXT.md");

/** Iterate an async iterable but break immediately when an AbortSignal fires. */
async function* abortable<T>(iterable: AsyncIterable<T>, signal: AbortSignal): AsyncGenerator<T> {
  const iterator = iterable[Symbol.asyncIterator]();
  const abortPromise = new Promise<never>((_, reject) => {
    signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
  });
  try {
    while (true) {
      const result = await Promise.race([iterator.next(), abortPromise]);
      if (result.done) break;
      yield result.value;
    }
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") return;
    throw err;
  } finally {
    iterator.return?.();
  }
}

// Distinguish "/help" (command) from "/Users/foo/bar.pdf" (file path).
function isSlashCommand(text: string): boolean {
  if (!text.startsWith("/")) return false;
  if (text === "/") return true;
  const firstToken = text.slice(1).split(/\s/)[0] || "";
  return !firstToken.includes("/");
}

const fuse = new Fuse(commands, {
  keys: ["name", "description"],
  threshold: 0.4,
  minMatchCharLength: 1,
});

interface MessageItem {
  id: number;
  message: Message;
}

// nextId is a useRef inside the component — see nextIdRef

function extractKeyArg(input: Record<string, unknown>): string {
  const filePath = input.file_path || input.path;
  if (typeof filePath === "string") {
    return filePath.split("/").slice(-2).join("/");
  }
  const q = input.query || input.sql;
  if (typeof q === "string") {
    return q.length > 50 ? q.slice(0, 50) + "..." : q;
  }
  const key = input.key || input.name || input.topic;
  if (typeof key === "string") {
    return key.length > 50 ? key.slice(0, 50) + "..." : key;
  }
  for (const v of Object.values(input)) {
    if (typeof v === "string" && v.length > 0) {
      return v.length > 50 ? v.slice(0, 50) + "..." : v;
    }
  }
  return "";
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

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const min = Math.floor(seconds / 60);
  const sec = seconds % 60;
  return `${min}m ${sec.toString().padStart(2, "0")}s`;
}

interface ActiveTool {
  id: string;
  index: number;
  name: string;
  keyArg: string;
  startTime: number;
}

const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function ActiveToolsBar({ tools, elapsed }: { tools: ActiveTool[]; elapsed: number }) {
  if (tools.length === 0) return null;

  return (
    <Box flexDirection="column">
      {tools.map((tool) => {
        const toolElapsed = Math.floor((Date.now() - tool.startTime) / 1000);
        const frame = spinnerFrames[(elapsed + tool.index) % spinnerFrames.length];
        return (
          <Box key={tool.id}>
            <Text color="cyan" dimColor>  {frame} [{tool.index}] {tool.name}{tool.keyArg ? `: ${tool.keyArg}` : ""} ({formatElapsed(toolElapsed)})</Text>
          </Box>
        );
      })}
    </Box>
  );
}

function ToolActivityLine({ content }: { content: string }) {
  const [label, timeStr] = content.split("|||");
  const isError = label.startsWith("✗");
  return (
    <Box>
      <Text color={isError ? "red" : "gray"} dimColor={!isError}>  {label}</Text>
      <Text color="gray" dimColor> {timeStr}</Text>
    </Box>
  );
}

function renderMessage(item: MessageItem) {
  const { role, content } = item.message;
  switch (role) {
    case "user":
    case "assistant":
      return <ChatBubble role={role}>{content}</ChatBubble>;
    case "thinking":
      return (
        <Box marginLeft={1}>
          <Text dimColor wrap="wrap">{content}</Text>
        </Box>
      );
    case "tool_activity":
      return <ToolActivityLine content={content} />;
    case "status":
      return <Text color="gray">{content}</Text>;
    case "system":
      return (
        <Box marginBottom={1}>
          <Text color="yellow">{content}</Text>
        </Box>
      );
    default:
      return null;
  }
}

export default function App({ resume = false }: { resume?: boolean }) {
  const { exit } = useApp();
  const [input, setInput] = useState("");

  // Two-tier rendering: committed (Static, scrollback) + dynamic (live, below Static)
  // Items stay in dynamic until the NEXT user interaction commits them to Static.
  // This avoids the race condition where items exist in both areas simultaneously.
  const [committed, setCommitted] = useState<MessageItem[]>([]);
  const [dynamic, setDynamic] = useState<MessageItem[]>([]);
  const [streamingText, setStreamingText] = useState<string | null>(null);
  const [debugMessages, setDebugMessages] = useState<Message[]>([]);

  const [isProcessing, setIsProcessing] = useState(false);
  const [suggestions, setSuggestions] = useState<Command[]>([]);
  const [selectedSuggestion, setSelectedSuggestion] = useState(0);
  const [showWelcome, setShowWelcome] = useState(true);
  const [verbose, setVerbose] = useState(false);
  const [hasCheckedFirstTime, setHasCheckedFirstTime] = useState(false);
  const [activeTools, setActiveTools] = useState<ActiveTool[]>([]);

  // AskUserQuestion support — deferred promise pattern
  const [pendingQuestion, setPendingQuestion] = useState<AskQuestion[] | null>(null);
  const questionResolverRef = useRef<((result: PermissionResult) => void) | null>(null);
  const questionInputRef = useRef<Record<string, unknown> | null>(null);

  const nextIdRef = useRef(0);
  const prevSuggestionsLen = useRef(0);
  const toolCountRef = useRef(0);
  const activeToolsMapRef = useRef(new Map<string, ActiveTool>());
  const abortControllerRef = useRef<AbortController | null>(null);
  const processingStartRef = useRef(0);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!isProcessing) {
      setElapsed(0);
      return;
    }
    processingStartRef.current = Date.now();
    const interval = setInterval(() => {
      setElapsed(Math.floor((Date.now() - processingStartRef.current) / 1000));
    }, 1000);
    return () => clearInterval(interval);
  }, [isProcessing]);

  useEffect(() => {
    if (isSlashCommand(input)) {
      const partial = input.slice(1).split(/\s+/)[0];
      if (!partial) {
        setSuggestions(commands);
        setSelectedSuggestion(0);
      } else {
        const matches = fuse.search(partial).map((r) => r.item).slice(0, 6);
        setSuggestions(matches);
        setSelectedSuggestion(0);
      }
      prevSuggestionsLen.current = -1;
    } else {
      if (prevSuggestionsLen.current !== 0) {
        setSuggestions([]);
        prevSuggestionsLen.current = 0;
      }
    }
  }, [input]);

  useEffect(() => {
    if (hasCheckedFirstTime || isProcessing) return;

    const checkFirstTimeUser = async () => {
      if (resume) {
        const lastSession = await loadPersistedSession();
        if (lastSession) {
          setSessionId(lastSession);
          setHasCheckedFirstTime(true);
          setShowWelcome(false);

          const history = await loadChatHistory();
          if (history.length > 0) {
            setCommitted(history.map((message) => ({ id: nextIdRef.current++, message })));
          }
          addMessage("status", "Resumed previous session", true);
          return;
        }
        addMessage("status", "No previous session found, starting fresh", true);
      }

      let needsOnboarding = false;
      try {
        const contextContent = await fs.readFile(CONTEXT_FILE, "utf-8");
        needsOnboarding = contextContent.includes("[not set]") || contextContent.includes("[No goals set yet]");
      } catch {
        needsOnboarding = true;
      }

      if (needsOnboarding) {
        setHasCheckedFirstTime(true);
        setShowWelcome(false);
        addMessage("system", "Welcome! Let me help you get started...\n", true);

        const setupCommand = getCommandByName("setup");
        if (setupCommand) {
          const context: CommandContext = {
            print: (text) => addMessage("system", text),
            streamResponse,
            getMessages: () => [...committed, ...dynamic].map((i) => i.message),
          };
          await setupCommand.handler([], context);
        }
      } else {
        setHasCheckedFirstTime(true);
        setShowWelcome(false);
        await streamResponse("[Session start]");
      }
    };

    checkFirstTimeUser();
  }, [hasCheckedFirstTime, isProcessing]);

  useInput(
    (_char, key) => {
      if (key.escape && isProcessing && abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    },
    { isActive: isProcessing && !pendingQuestion }
  );

  useInput(
    (_char, key) => {
      if (isProcessing || pendingQuestion) return;

      if (key.upArrow && suggestions.length > 0) {
        setSelectedSuggestion((prev) => Math.max(0, prev - 1));
      } else if (key.downArrow && suggestions.length > 0) {
        setSelectedSuggestion((prev) => Math.min(suggestions.length - 1, prev + 1));
      } else if (key.tab && suggestions.length > 0) {
        const selected = suggestions[selectedSuggestion];
        if (selected) {
          setInput(`/${selected.name} `);
          setSuggestions([]);
        }
      } else if (key.escape) {
        setSuggestions([]);
        setInput("");
      }
    },
    { isActive: suggestions.length > 0 || isSlashCommand(input) }
  );

  // Add a message. direct=true goes straight to Static (startup/non-streaming).
  // direct=false goes to the dynamic area (during streaming or user interaction).
  const addMessage = (role: Message["role"], content: string, direct = false) => {
    if (role === "tool" || role === "debug" || role === "error") {
      setDebugMessages((prev) => [...prev.slice(-100), { role, content }]);
      return;
    }
    const item: MessageItem = { id: nextIdRef.current++, message: { role, content } };
    if (direct) {
      setCommitted((prev) => [...prev, item]);
    } else {
      setDynamic((prev) => [...prev, item]);
    }
    if (role === "user" || role === "assistant") {
      appendChatMessage({ role, content });
    }
  };

  // Move all dynamic items to Static in one batch. Called at the START of
  // the next user interaction, not at the end of a response. This ensures
  // items never exist in both Static and dynamic simultaneously.
  const commitDynamic = () => {
    setDynamic((prev) => {
      if (prev.length > 0) {
        setCommitted((c) => [...c, ...prev]);
      }
      return [];
    });
  };

  const streamResponse = async (prompt: string, attachments?: FileAttachment[]) => {
    setIsProcessing(true);
    toolCountRef.current = 0;
    activeToolsMapRef.current.clear();
    setActiveTools([]);
    setStreamingText(null);
    let currentResponse = "";
    let hadToolCall = false;

    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    try {
      // canUseTool callback — auto-approves everything except AskUserQuestion,
      // which gets rendered as an interactive prompt. The SDK blocks the query()
      // generator while this Promise is pending.
      const canUseTool = async (
        toolName: string,
        input: Record<string, unknown>,
        options: { signal: AbortSignal },
      ): Promise<PermissionResult> => {
        log("canUseTool", toolName, { inputKeys: Object.keys(input) });
        if (toolName !== "AskUserQuestion") {
          return { behavior: "allow", updatedInput: input };
        }
        const questions = (input as { questions: AskQuestion[] }).questions;
        return new Promise<PermissionResult>((resolve) => {
          options.signal.addEventListener("abort", () => {
            setPendingQuestion(null);
            questionResolverRef.current = null;
            questionInputRef.current = null;
            resolve({ behavior: "deny", message: "Aborted" });
          }, { once: true });
          questionResolverRef.current = resolve;
          questionInputRef.current = input;
          setPendingQuestion(questions);
        });
      };

      const options = await createAgentOptions(canUseTool);

      if (attachments && attachments.length > 0) {
        const contentBlocks = buildContentBlocks(prompt, attachments);
        async function* messageStream(): AsyncIterable<SDKUserMessage> {
          yield {
            type: "user",
            message: { role: "user", content: contentBlocks as any },
            parent_tool_use_id: null,
            session_id: getCurrentSessionId() ?? crypto.randomUUID(),
          };
        }
        for await (const message of abortable(query({ prompt: messageStream(), options }), abortController.signal)) {
          handleMessage(message);
        }
      } else {
        for await (const message of abortable(query({ prompt, options }), abortController.signal)) {
          handleMessage(message);
        }
      }
    } catch (error) {
      if (!abortController.signal.aborted) {
        addMessage("system", `Error: ${error instanceof Error ? error.message : error}`);
      }
    }

    // Add final streaming text as a message
    if (currentResponse.trim()) {
      addMessage("assistant", currentResponse);
    }
    if (abortController.signal.aborted) {
      addMessage("status", "Cancelled");
    }

    // Clean up pending question if stream ended while prompt was active
    if (questionResolverRef.current) {
      questionResolverRef.current({ behavior: "deny", message: "Session ended" });
      questionResolverRef.current = null;
      questionInputRef.current = null;
      setPendingQuestion(null);
    }

    // Clean up — items stay in dynamic until next user interaction commits them
    setStreamingText(null);
    setActiveTools([]);
    setIsProcessing(false);
    abortControllerRef.current = null;
    activeToolsMapRef.current.clear();

    function handleMessage(message: SDKMessage) {
      log("sdk_message", message.type, "subtype" in message ? { subtype: (message as any).subtype } : undefined);

      switch (message.type) {
        case "system":
          log("system_msg", JSON.stringify(message).slice(0, 2000));
          if ("subtype" in message && message.subtype === "init") {
            const initMsg = message as SDKMessage & { model: string; session_id?: string };
            addMessage("debug", `Model: ${initMsg.model}`);
            if (initMsg.session_id) {
              saveSession(initMsg.session_id);
            }
          }
          break;

        case "assistant":
          for (const block of message.message.content) {
            if (block.type === "text") {
              if (hadToolCall) {
                hadToolCall = false;
              }

              currentResponse += block.text;
              setStreamingText(currentResponse);
            } else if (block.type === "tool_use") {
              log("tool_use", block.name, block.input);
              // Flush accumulated text as thinking
              if (currentResponse.trim()) {
                addMessage("thinking", currentResponse);
                currentResponse = "";
                setStreamingText(null);
              }
              hadToolCall = true;
              toolCountRef.current++;

              const toolName = block.name.replace("mcp__runnai__", "");
              const keyArg = extractKeyArg(block.input as Record<string, unknown>);
              const count = toolCountRef.current;
              const toolUseId = (block as any).id as string || `fallback-${count}`;

              const activeTool: ActiveTool = { id: toolUseId, index: count, name: toolName, keyArg, startTime: Date.now() };
              activeToolsMapRef.current.set(toolUseId, activeTool);
              setActiveTools([...activeToolsMapRef.current.values()]);

              const inputStr = formatToolInput(block.input as Record<string, unknown>);
              addMessage("tool", `→ ${toolName}(${inputStr})`);
            }
          }
          break;

        case "user":
          if (message.tool_use_result !== undefined) {
            const result = message.tool_use_result as unknown;
            const resultStr = typeof result === "string" ? result : JSON.stringify(result);
            log("tool_result", resultStr.slice(0, 1000));
            const isError = typeof result === "object" && result !== null &&
              "isError" in result && (result as Record<string, unknown>).isError === true;

            const toolUseId = extractToolUseId(message);
            const matchedTool = toolUseId ? activeToolsMapRef.current.get(toolUseId) : null;
            const tool = matchedTool || activeToolsMapRef.current.values().next().value || null;

            if (tool) {
              const elapsed = ((Date.now() - tool.startTime) / 1000).toFixed(1);
              const prefix = isError ? "✗" : "✓";
              const label = `${prefix} [${tool.index}] ${tool.name}${tool.keyArg ? `: ${tool.keyArg}` : ""}`;
              addMessage("tool_activity", `${label}|||${elapsed}s`);
              activeToolsMapRef.current.delete(tool.id);
              setActiveTools([...activeToolsMapRef.current.values()]);
            }

            if (isError) {
              const errorStr = typeof result === "string"
                ? result
                : JSON.stringify(result, null, 2);
              addMessage("error", `Tool error: ${errorStr.slice(0, 500)}`);
            } else {
              const resultStr = typeof result === "string"
                ? result.slice(0, 200) + (result.length > 200 ? "..." : "")
                : JSON.stringify(result).slice(0, 200);
              addMessage("tool", `← ${resultStr}`);
            }
          }
          break;

        case "tool_progress":
          break;

        case "result": {
          if (message.session_id) {
            saveSession(message.session_id);
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
          recordExchange(exchange);
          addMessage("status", formatExchangeLine(exchange));
          break;
        }
      }
    }
  };

  const formatToolInput = (input: Record<string, unknown>): string => {
    const parts: string[] = [];
    for (const [key, value] of Object.entries(input)) {
      if (typeof value === "string") {
        const short = value.length > 50 ? value.slice(0, 50) + "..." : value;
        parts.push(`${key}="${short}"`);
      } else {
        parts.push(`${key}=${JSON.stringify(value)}`);
      }
    }
    return parts.join(", ");
  };

  const handleSubmit = async (value: string) => {
    if (isProcessing) return;

    if (suggestions.length > 0) {
      const selected = suggestions[selectedSuggestion];
      if (selected) {
        const commandValue = `/${selected.name}`;
        setSuggestions([]);
        setInput("");
        setShowWelcome(false);
        value = commandValue;
      }
    }

    if (!value.trim()) return;

    // Commit previous dynamic items (previous response) to Static
    commitDynamic();
    setInput("");

    setShowWelcome(false);
    setSuggestions([]);

    if (isSlashCommand(value)) {
      const [cmdPart, ...args] = value.slice(1).split(/\s+/);
      const cmdName = cmdPart.toLowerCase();

      let command = getCommandByName(cmdName);
      if (!command) {
        const matches = fuse.search(cmdName);
        if (matches.length > 0 && matches[0].score! < 0.3) {
          command = matches[0].item;
        }
      }

      if (command) {
        addMessage("user", value);

        if (command.name === "exit") {
          addMessage("system", "Happy running!");
          setTimeout(() => exit(), 500);
          return;
        }

        if (command.name === "clear") {
          setCommitted([]);
          setDynamic([]);
          setDebugMessages([]);
          setInput("");
          clearPersistedSession();
          resetUsage();
          console.clear();
          return;
        }

        if (command.name === "verbose") {
          setVerbose((v) => !v);
          addMessage("system", `Verbose mode: ${!verbose ? "ON" : "OFF"}`);
          setInput("");
          return;
        }

        if (command.name === "reset-profile") {
          const dirsToClean = ["athlete", "memory", "plans", "research"];
          for (const dir of dirsToClean) {
            const fullPath = path.join(getDataDir(), dir);
            try {
              const entries = await fs.readdir(fullPath);
              for (const entry of entries) {
                if (entry === ".gitkeep" || entry === ".gitignore") continue;
                const entryPath = path.join(fullPath, entry);
                await fs.rm(entryPath, { recursive: true });
              }
            } catch {
              // Directory doesn't exist yet
            }
          }

          setCommitted([]);
          setDynamic([]);
          setDebugMessages([]);
          clearPersistedSession();
          resetUsage();
          setHasCheckedFirstTime(false);
          console.clear();
          addMessage("system", "Profile reset. Strava data preserved. Restarting onboarding...\n", true);
          setInput("");
          return;
        }

        if (command.name === "help") {
          let helpText = "\nAvailable Commands:\n";
          commands.forEach((cmd) => {
            helpText += `  /${cmd.name} — ${cmd.description}\n`;
          });
          addMessage("system", helpText);
          setInput("");
          return;
        }

        const context: CommandContext = {
          print: (text) => addMessage("system", text),
          streamResponse,
          getMessages: () => [...committed, ...dynamic].map((i) => i.message),
        };

        await command.handler(args, context);
      } else {
        addMessage("system", `Unknown command: /${cmdName}\nType /help for available commands.`);
      }
    } else {
      const { cleanText, attachments } = await detectAndReadFiles(value);

      addMessage("user", value);
      if (attachments.length > 0) {
        addMessage("status", `Attached ${attachments.length} file(s)`);
      }

      await streamResponse(cleanText, attachments.length > 0 ? attachments : undefined);
    }

  };

  return (
    <Box flexDirection="column" padding={1}>
      {/* Welcome header */}
      {showWelcome && (
        <Box flexDirection="column" marginBottom={1} borderStyle="round" borderColor="cyan" paddingX={2} paddingY={1}>
          <Text color="cyan" bold>
            RunnAI
          </Text>
          <Text dimColor>AI-Powered Running Coach</Text>
          <Box marginTop={1}>
            <Text dimColor>
              Type <Text color="yellow">/</Text> for commands, or just chat
            </Text>
          </Box>
        </Box>
      )}

      {/* Committed messages — persisted in scrollback */}
      <Static items={committed}>
        {(item) => (
          <Box key={item.id} flexDirection="column">
            {renderMessage(item)}
          </Box>
        )}
      </Static>

      {/* Dynamic items — stays here until next user interaction commits to Static */}
      {dynamic.map((item) => (
        <Box key={item.id} flexDirection="column">
          {renderMessage(item)}
        </Box>
      ))}

      {/* Live streaming message */}
      {streamingText && (
        <ChatBubble role="assistant">{streamingText}</ChatBubble>
      )}

      {/* AskUserQuestion interactive prompt */}
      {pendingQuestion && (
        <QuestionPrompt
          questions={pendingQuestion}
          onSubmit={(answers) => {
            const resolver = questionResolverRef.current;
            const input = questionInputRef.current;
            questionResolverRef.current = null;
            questionInputRef.current = null;
            setPendingQuestion(null);
            resolver?.({
              behavior: "allow",
              updatedInput: { ...input, answers },
            });
          }}
          onCancel={(reason) => {
            const resolver = questionResolverRef.current;
            questionResolverRef.current = null;
            questionInputRef.current = null;
            setPendingQuestion(null);
            resolver?.({
              behavior: "deny",
              message: reason === "chat"
                ? "User wants to discuss this conversationally instead. Ask them in natural language."
                : "User dismissed the question prompt.",
            });
          }}
        />
      )}

      {/* Active tools progress — hidden during question prompt */}
      {isProcessing && !pendingQuestion && (
        <ActiveToolsBar tools={activeTools} elapsed={elapsed} />
      )}

      {/* Debug panel */}
      {verbose && debugMessages.length > 0 && (
        <Box
          flexDirection="column"
          borderStyle="single"
          borderColor="gray"
          paddingX={1}
          marginBottom={1}
        >
          <Text dimColor bold>Debug ({debugMessages.length} entries)</Text>
          {debugMessages.slice(-15).map((msg, i) => (
            <Text key={i} color={msg.role === "error" ? "red" : "gray"} dimColor={msg.role !== "error"}>
              {msg.role === "error" ? "❌ " : ""}{msg.content}
            </Text>
          ))}
        </Box>
      )}

      {/* Command suggestions dropdown */}
      {suggestions.length > 0 && (
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor="yellow"
          paddingX={1}
          marginBottom={1}
        >
          <Text dimColor>Commands:</Text>
          {suggestions.map((cmd, i) => (
            <Text
              key={cmd.name}
              backgroundColor={i === selectedSuggestion ? "blue" : undefined}
              color={i === selectedSuggestion ? "white" : undefined}
            >
              <Text color={i === selectedSuggestion ? "white" : "yellow"} bold>
                /{cmd.name}
              </Text>
              <Text dimColor={i !== selectedSuggestion}> {cmd.description}</Text>
            </Text>
          ))}
          <Text dimColor>↑↓ navigate · Tab complete · Esc cancel</Text>
        </Box>
      )}

      {/* Input area — hidden during question prompt */}
      {!pendingQuestion && (
        <Box borderStyle="round" borderColor={isProcessing ? "gray" : "cyan"} paddingX={1}>
          <Text color="cyan" bold>{">"} </Text>
          {isProcessing ? (
            <Text dimColor>Thinking...{elapsed > 0 ? ` (${formatElapsed(elapsed)})` : ""} · Esc to cancel</Text>
          ) : (
            <TextInput
              value={input}
              onChange={setInput}
              onSubmit={handleSubmit}
              placeholder="Ask anything or type / for commands"
            />
          )}
        </Box>
      )}

      {/* Footer hint */}
      {!showWelcome && !isProcessing && (
        <Box marginTop={1}>
          <Text dimColor>
            /help for commands · /verbose to {verbose ? "hide" : "show"} debug info
          </Text>
        </Box>
      )}
    </Box>
  );
}
