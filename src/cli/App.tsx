import React, { useState, useEffect, useRef } from "react";
import { Box, Text, Static, useInput, useApp } from "ink";
import { TextInput } from "./components/TextInput.js";
import Fuse from "fuse.js";
import * as fs from "fs/promises";
import * as path from "path";
import { query, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { createAgentOptions, PROJECT_ROOT } from "../agent.js";
import { setSessionId, resetSession, getCurrentSessionId, loadPersistedSession, saveSession, clearPersistedSession, appendChatMessage, loadChatHistory, clearChatHistory } from "../utils/session.js";
import { detectAndReadFiles, buildContentBlocks, type FileAttachment } from "../utils/file-attachments.js";
import { recordExchange, resetUsage, formatExchangeLine, type ExchangeUsage } from "../utils/usage-tracker.js";
import { commands, getCommandByName, type Command, type CommandContext, type Message } from "./commands.js";
import { ChatBubble } from "./components/ChatBubble.js";

const CONTEXT_FILE = path.join(PROJECT_ROOT, "data/athlete/CONTEXT.md");
const STRAVA_DB = path.join(PROJECT_ROOT, "data/strava/activities.db");

// Distinguish "/help" (command) from "/Users/foo/bar.pdf" (file path).
// A command is /word where the word contains no further slashes.
function isSlashCommand(text: string): boolean {
  if (!text.startsWith("/")) return false;
  if (text === "/") return true;
  const firstToken = text.slice(1).split(/\s/)[0] || "";
  return !firstToken.includes("/");
}

// Fuse.js for fuzzy command matching
const fuse = new Fuse(commands, {
  keys: ["name", "description"],
  threshold: 0.4,
  minMatchCharLength: 1,
});

// Item rendered once via <Static> — never re-rendered
interface StaticItem {
  id: number;
  message: Message;
}

let nextStaticId = 0;

// Extract the most useful argument to show in the status bar
function extractKeyArg(input: Record<string, unknown>): string {
  // File path tools
  const filePath = input.file_path || input.path;
  if (typeof filePath === "string") {
    const parts = filePath.split("/");
    return parts.slice(-2).join("/");
  }
  // Query tools
  const query = input.query || input.sql;
  if (typeof query === "string") {
    return query.length > 50 ? query.slice(0, 50) + "..." : query;
  }
  // Memory / keyed tools
  const key = input.key || input.name || input.topic;
  if (typeof key === "string") {
    return key.length > 50 ? key.slice(0, 50) + "..." : key;
  }
  // Fallback: first short string arg
  for (const v of Object.values(input)) {
    if (typeof v === "string" && v.length > 0) {
      return v.length > 50 ? v.slice(0, 50) + "..." : v;
    }
  }
  return "";
}

// Extract tool_use_id from a user message containing tool_result blocks
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
  id: string;        // tool_use_id from SDK
  index: number;     // sequential counter
  name: string;
  keyArg: string;
  startTime: number;
}

const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function ActiveToolsBar({ tools, elapsed }: { tools: ActiveTool[]; elapsed: number }) {
  if (tools.length === 0) {
    if (elapsed === 0) return null;
    return (
      <Box>
        <Text color="gray" dimColor>  Thinking... ({formatElapsed(elapsed)})</Text>
      </Box>
    );
  }

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

export default function App({ resume = false }: { resume?: boolean }) {
  const { exit } = useApp();
  const [input, setInput] = useState("");

  // Static items: rendered once, pushed to stdout, never re-rendered
  const [staticItems, setStaticItems] = useState<StaticItem[]>([]);
  // Live streaming text: re-renders as chunks arrive
  const [streamingText, setStreamingText] = useState<string | null>(null);
  // Debug messages: only shown in verbose panel
  const [debugMessages, setDebugMessages] = useState<Message[]>([]);

  const [isProcessing, setIsProcessing] = useState(false);
  const [suggestions, setSuggestions] = useState<Command[]>([]);
  const [selectedSuggestion, setSelectedSuggestion] = useState(0);
  const [showWelcome, setShowWelcome] = useState(true);
  const [verbose, setVerbose] = useState(false);
  const [hasCheckedFirstTime, setHasCheckedFirstTime] = useState(false);
  const [activeTools, setActiveTools] = useState<ActiveTool[]>([]);

  // Ref to avoid stale closures in suggestion effect
  const prevSuggestionsLen = useRef(0);
  // Track tool calls per exchange for richer progress display
  const toolCountRef = useRef(0);
  // Map of active tools keyed by tool_use_id — source of truth (safe in closures)
  const activeToolsMapRef = useRef(new Map<string, ActiveTool>());
  // AbortController for cancelling active queries
  const abortControllerRef = useRef<AbortController | null>(null);
  // Live elapsed timer during processing
  const processingStartRef = useRef(0);
  const [elapsed, setElapsed] = useState(0);

  // Live elapsed timer: ticks every second while processing
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

  // Update suggestions when input changes
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
      prevSuggestionsLen.current = -1; // force: has suggestions
    } else {
      // Only clear if we previously had suggestions (avoid no-op re-render)
      if (prevSuggestionsLen.current !== 0) {
        setSuggestions([]);
        prevSuggestionsLen.current = 0;
      }
    }
  }, [input]);

  // Check for first-time user and auto-trigger onboarding
  useEffect(() => {
    if (hasCheckedFirstTime || isProcessing) return;

    const checkFirstTimeUser = async () => {
      // If --resume flag: load last session and replay chat history
      if (resume) {
        const lastSession = await loadPersistedSession();
        if (lastSession) {
          setSessionId(lastSession);
          setHasCheckedFirstTime(true);
          setShowWelcome(false);

          const history = await loadChatHistory();
          if (history.length > 0) {
            setStaticItems(history.map((message) => ({ id: nextStaticId++, message })));
          }
          commitMessage("status", "Resumed previous session");
          return;
        }
        // No session to resume — fall through to normal startup
        commitMessage("status", "No previous session found, starting fresh");
      }

      try {
        const contextContent = await fs.readFile(CONTEXT_FILE, "utf-8");
        const isFirstTime = contextContent.includes("[not set]") || contextContent.includes("[No goals set yet]");

        if (isFirstTime) {
          setHasCheckedFirstTime(true);
          setShowWelcome(false);
          commitMessage("system", "Welcome! Let me help you get started...\n");

          const setupCommand = getCommandByName("setup");
          if (setupCommand) {
            const context: CommandContext = {
              print: (text) => commitMessage("system", text),
              streamResponse,
              getMessages: () => staticItems.map((i) => i.message),
            };
            await setupCommand.handler([], context);
          }
        } else {
          setHasCheckedFirstTime(true);
          setShowWelcome(false);
          await streamResponse("[Session start]");
        }
      } catch {
        // CONTEXT.md missing — check if Strava data exists (reset vs truly first-time)
        setHasCheckedFirstTime(true);
        setShowWelcome(false);

        let hasStravaData = false;
        try {
          await fs.access(STRAVA_DB);
          hasStravaData = true;
        } catch {}

        if (hasStravaData) {
          // Profile was reset but Strava data exists — rebuild from existing data
          await streamResponse(
            "[Profile reset] My profile was reset but Strava data is intact. Rebuild my athlete profile from existing Strava data: fetch my profile (strava_profile), read the recent summary, analyze my training patterns, then ask me about my goals. Do NOT re-sync Strava — the database is already up to date."
          );
        } else {
          // Truly first-time user — full setup
          commitMessage("system", "Welcome! Let me help you get started...\n");

          const setupCommand = getCommandByName("setup");
          if (setupCommand) {
            const context: CommandContext = {
              print: (text) => commitMessage("system", text),
              streamResponse,
              getMessages: () => staticItems.map((i) => i.message),
            };
            await setupCommand.handler([], context);
          }
        }
      }
    };

    checkFirstTimeUser();
  }, [hasCheckedFirstTime, isProcessing]);

  // Handle Escape to cancel active query
  useInput(
    (_char, key) => {
      if (key.escape && isProcessing && abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    },
    { isActive: isProcessing }
  );

  // Handle keyboard input for navigation
  useInput(
    (_char, key) => {
      if (isProcessing) return;

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

  // Commit a finalized message to static output
  const commitMessage = (role: Message["role"], content: string) => {
    if (role === "tool" || role === "debug" || role === "error") {
      setDebugMessages((prev) => [...prev.slice(-100), { role, content }]);
    } else {
      const message: Message = { role, content };
      setStaticItems((prev) => [...prev, { id: nextStaticId++, message }]);
      if (role === "user" || role === "assistant") {
        appendChatMessage(message);
      }
    }
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
      const options = await createAgentOptions();

      if (attachments && attachments.length > 0) {
        // Multimodal path: send content blocks with file attachments
        const contentBlocks = buildContentBlocks(prompt, attachments);
        async function* messageStream(): AsyncIterable<SDKUserMessage> {
          yield {
            type: "user",
            message: { role: "user", content: contentBlocks as any },
            parent_tool_use_id: null,
            session_id: getCurrentSessionId() ?? crypto.randomUUID(),
          };
        }
        for await (const message of query({ prompt: messageStream(), options })) {
          if (abortController.signal.aborted) break;
          handleMessage(message);
        }
      } else {
        // Simple string path (unchanged)
        for await (const message of query({ prompt, options })) {
          if (abortController.signal.aborted) break;
          handleMessage(message);
        }
      }
    } catch (error) {
      if (!abortController.signal.aborted) {
        commitMessage("system", `Error: ${error instanceof Error ? error.message : error}`);
      }
    }

    // Commit final streaming text as a static message
    if (currentResponse.trim()) {
      commitMessage("assistant", currentResponse);
    }
    if (abortController.signal.aborted) {
      commitMessage("status", "Cancelled");
    }
    abortControllerRef.current = null;
    setStreamingText(null);
    activeToolsMapRef.current.clear();
    setActiveTools([]);
    setIsProcessing(false);

    function handleMessage(message: SDKMessage) {
      switch (message.type) {
        case "system":
          if ("subtype" in message && message.subtype === "init") {
            const initMsg = message as SDKMessage & { model: string; session_id?: string };
            commitMessage("debug", `Model: ${initMsg.model}`);
            if (initMsg.session_id) {
              saveSession(initMsg.session_id);
            }
          }
          break;

        case "assistant":
          for (const block of message.message.content) {
            if (block.type === "text") {
              if (hadToolCall) {
                // Commit previous response, start new bubble
                if (currentResponse.trim()) {
                  commitMessage("assistant", currentResponse);
                }
                currentResponse = "";
                hadToolCall = false;
              }

              currentResponse += block.text;
              setStreamingText(currentResponse);
            } else if (block.type === "tool_use") {
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
              commitMessage("tool", `→ ${toolName}(${inputStr})`);
            }
          }
          break;

        case "user":
          if (message.tool_use_result !== undefined) {
            const result = message.tool_use_result as unknown;
            const isError = typeof result === "object" && result !== null &&
              "isError" in result && (result as Record<string, unknown>).isError === true;

            // Find which tool this result belongs to via tool_use_id
            const toolUseId = extractToolUseId(message);
            const matchedTool = toolUseId ? activeToolsMapRef.current.get(toolUseId) : null;
            // Fallback: grab first tool in map if we can't match by ID
            const tool = matchedTool || activeToolsMapRef.current.values().next().value || null;

            if (tool) {
              const elapsed = ((Date.now() - tool.startTime) / 1000).toFixed(1);
              const prefix = isError ? "✗" : "✓";
              const label = `${prefix} [${tool.index}] ${tool.name}${tool.keyArg ? `: ${tool.keyArg}` : ""}`;
              commitMessage("tool_activity", `${label}|||${elapsed}s`);
              activeToolsMapRef.current.delete(tool.id);
              setActiveTools([...activeToolsMapRef.current.values()]);
            }

            // Still log details to debug
            if (isError) {
              const errorStr = typeof result === "string"
                ? result
                : JSON.stringify(result, null, 2);
              commitMessage("error", `Tool error: ${errorStr.slice(0, 500)}`);
            } else {
              const resultStr = typeof result === "string"
                ? result.slice(0, 200) + (result.length > 200 ? "..." : "")
                : JSON.stringify(result).slice(0, 200);
              commitMessage("tool", `← ${resultStr}`);
            }
          }
          break;

        case "tool_progress": {
          // Elapsed is computed from startTime; no state update needed
          break;
        }

        case "result": {
          if (message.session_id) {
            saveSession(message.session_id);
          }

          // Handle error subtypes
          const subtype = (message as any).subtype as string | undefined;
          if (subtype && subtype !== "success") {
            const errorMessages: Record<string, string> = {
              error_max_turns: "Reached maximum turns limit. Try breaking the task into smaller steps.",
              error_during_execution: "An error occurred during execution.",
              error_tool_use: "A tool use error occurred.",
            };
            commitMessage("system", errorMessages[subtype] || `Session ended with: ${subtype}`);
          }

          // Sum token counts from modelUsage (Record<string, ModelUsage>)
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
          commitMessage("status", formatExchangeLine(exchange));
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

    // If suggestions are visible, select and execute the highlighted command
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
        commitMessage("user", value);

        if (command.name === "exit") {
          commitMessage("system", "Happy running!");
          setTimeout(() => exit(), 500);
          return;
        }

        if (command.name === "clear") {
          setStaticItems([]);
          setDebugMessages([]);
          setInput("");
          clearPersistedSession();
          resetUsage();
          console.clear();
          return;
        }

        if (command.name === "verbose") {
          setVerbose((v) => !v);
          commitMessage("system", `Verbose mode: ${!verbose ? "ON" : "OFF"}`);
          setInput("");
          return;
        }

        if (command.name === "reset-profile") {
          // Delete profile and memory, keep Strava data
          const dirsToClean = ["data/athlete", "data/memory", "data/plans", "data/research"];
          for (const dir of dirsToClean) {
            const fullPath = path.join(PROJECT_ROOT, dir);
            try {
              const entries = await fs.readdir(fullPath);
              for (const entry of entries) {
                if (entry === ".gitkeep" || entry === ".gitignore") continue;
                const entryPath = path.join(fullPath, entry);
                await fs.rm(entryPath, { recursive: true });
              }
            } catch {
              // Directory doesn't exist yet, that's fine
            }
          }

          // Reset UI and session state, re-trigger onboarding
          setStaticItems([]);
          setDebugMessages([]);
          clearPersistedSession();
          resetUsage();
          setHasCheckedFirstTime(false);
          console.clear();
          commitMessage("system", "Profile reset. Strava data preserved. Restarting onboarding...\n");
          setInput("");
          return;
        }

        if (command.name === "help") {
          let helpText = "\nAvailable Commands:\n";
          commands.forEach((cmd) => {
            helpText += `  /${cmd.name} — ${cmd.description}\n`;
          });
          commitMessage("system", helpText);
          setInput("");
          return;
        }

        const context: CommandContext = {
          print: (text) => commitMessage("system", text),
          streamResponse,
          getMessages: () => staticItems.map((i) => i.message),
        };

        await command.handler(args, context);
      } else {
        commitMessage("system", `Unknown command: /${cmdName}\nType /help for available commands.`);
      }
    } else {
      const { cleanText, attachments } = await detectAndReadFiles(value);

      commitMessage("user", value);
      if (attachments.length > 0) {
        commitMessage("status", `Attached ${attachments.length} file(s)`);
      }

      await streamResponse(cleanText, attachments.length > 0 ? attachments : undefined);
    }

    setInput("");
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

      {/* Static message history — rendered once, never re-rendered on keystrokes */}
      <Static items={staticItems}>
        {(item) => (
          <Box key={item.id} flexDirection="column">
            {(item.message.role === "user" || item.message.role === "assistant") && (
              <ChatBubble role={item.message.role}>{item.message.content}</ChatBubble>
            )}
            {item.message.role === "tool_activity" && (
              <ToolActivityLine content={item.message.content} />
            )}
            {item.message.role === "status" && (
              <Box>
                <Text color="gray">{item.message.content}</Text>
              </Box>
            )}
            {item.message.role === "system" && (
              <Box marginBottom={1}>
                <Text color="yellow">{item.message.content}</Text>
              </Box>
            )}
          </Box>
        )}
      </Static>

      {/* Live streaming message — re-renders as chunks arrive */}
      {streamingText && (
        <ChatBubble role="assistant">{streamingText}</ChatBubble>
      )}

      {/* Active tools progress */}
      {isProcessing && (
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

      {/* Input area */}
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
