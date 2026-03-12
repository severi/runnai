import React, { useState, useEffect, useRef, useCallback } from "react";
import { Box, Text, Static, useInput, useApp } from "ink";
import { TextInput } from "./components/TextInput.js";
import * as fs from "fs/promises";
import * as path from "path";
import { query, type SDKUserMessage, type Query } from "@anthropic-ai/claude-agent-sdk";
import { createAgentOptions } from "../agent.js";
import { getDataDir, PROJECT_ROOT } from "../utils/paths.js";
import { getCurrentSessionId } from "../utils/session.js";
import { detectAndReadFiles, buildContentBlocks, type FileAttachment } from "../utils/file-attachments.js";
import { startupSync, formatNewRunsPrompt, formatCompactStatus } from "../utils/startup-sync.js";
import { logEvent } from "../utils/logger.js";
import { commands, getCommandByName, type CommandContext, type Message } from "./commands.js";
import { ChatBubble } from "./components/ChatBubble.js";
import { QuestionPrompt, type AskQuestion } from "./components/QuestionPrompt.js";
import type { PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import { useElapsedTimer } from "./hooks/useElapsedTimer.js";
import { useToolTracker, type ActiveTool } from "./hooks/useToolTracker.js";
import { useCommandSuggestions, isSlashCommand, fuse } from "./hooks/useCommandSuggestions.js";
import { handleSdkMessage, setLastUserUuid, resetTurn, type MessageHandlerState } from "./handleSdkMessage.js";
import { createMessageChannel, type MessageChannel } from "../utils/message-channel.js";

const CONTEXT_FILE = path.join(getDataDir(), "athlete/CONTEXT.md");

function getTimeGreeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return "Good morning!";
  if (hour < 17) return "Good afternoon!";
  return "Good evening!";
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const min = Math.floor(seconds / 60);
  const sec = seconds % 60;
  return `${min}m ${sec.toString().padStart(2, "0")}s`;
}

interface MessageItem {
  id: number;
  message: Message;
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

export default function App() {
  const { exit } = useApp();
  const [input, setInput] = useState("");

  // Two-tier rendering: committed (Static, scrollback) + dynamic (live, below Static)
  const [committed, setCommitted] = useState<MessageItem[]>([]);
  const [dynamic, setDynamic] = useState<MessageItem[]>([]);
  const [streamingText, setStreamingText] = useState<string | null>(null);
  const [debugMessages, setDebugMessages] = useState<Message[]>([]);

  const [isProcessing, setIsProcessing] = useState(false);
  const [showWelcome, setShowWelcome] = useState(true);
  const [verbose, setVerbose] = useState(false);
  const [hasStarted, setHasStarted] = useState(false);
  const [sessionEnded, setSessionEnded] = useState(false);

  // AskUserQuestion support — deferred promise pattern
  const [pendingQuestion, setPendingQuestion] = useState<AskQuestion[] | null>(null);
  const questionResolverRef = useRef<((result: PermissionResult) => void) | null>(null);
  const questionInputRef = useRef<Record<string, unknown> | null>(null);

  const nextIdRef = useRef(0);

  // Persistent subprocess refs
  const queryRef = useRef<Query | null>(null);
  const channelRef = useRef<MessageChannel<SDKUserMessage> | null>(null);
  const turnResolveRef = useRef<(() => void) | null>(null);
  const turnStateRef = useRef<MessageHandlerState | null>(null);
  // Serialization queue — prevents concurrent streamResponse calls from corrupting turn refs
  const turnQueueRef = useRef<Promise<void>>(Promise.resolve());

  // Extracted hooks
  const elapsed = useElapsedTimer(isProcessing);
  const toolTracker = useToolTracker();
  const { suggestions, selectedSuggestion, setSuggestions, setSelectedSuggestion } =
    useCommandSuggestions(input, isProcessing, pendingQuestion, setInput);

  const addMessage = useCallback((role: Message["role"], content: string, direct = false) => {
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
  }, []);

  const commitDynamic = useCallback(() => {
    setDynamic((prev) => {
      if (prev.length > 0) {
        setCommitted((c) => [...c, ...prev]);
      }
      return [];
    });
  }, []);

  // Initialize persistent subprocess on mount
  useEffect(() => {
    if (hasStarted) return;
    setHasStarted(true);

    const init = async () => {
      const canUseTool = async (
        toolName: string,
        toolInput: Record<string, unknown>,
        options: { signal: AbortSignal },
      ): Promise<PermissionResult> => {
        logEvent("system", { subtype: "can_use_tool", tool: toolName, input_keys: Object.keys(toolInput) });
        if (toolName !== "AskUserQuestion") {
          return { behavior: "allow", updatedInput: toolInput };
        }
        const questions = (toolInput as { questions: AskQuestion[] }).questions;
        return new Promise<PermissionResult>((resolve) => {
          options.signal.addEventListener("abort", () => {
            setPendingQuestion(null);
            questionResolverRef.current = null;
            questionInputRef.current = null;
            resolve({ behavior: "deny", message: "Aborted" });
          }, { once: true });
          questionResolverRef.current = resolve;
          questionInputRef.current = toolInput;
          setPendingQuestion(questions);
        });
      };

      // Check onboarding status early — needed to decide startup path
      let needsOnboarding = false;
      try {
        const contextContent = await fs.readFile(CONTEXT_FILE, "utf-8");
        needsOnboarding = contextContent.includes("[not set]") || contextContent.includes("[No goals set yet]");
      } catch {
        needsOnboarding = true;
      }

      // For returning users: show generic greeting immediately, then sync in parallel
      let ctx: Awaited<ReturnType<typeof startupSync>>;
      let agentOptions: Awaited<ReturnType<typeof createAgentOptions>>;
      let greetingIsBackground = false;

      if (!needsOnboarding) {
        setShowWelcome(false);
        addMessage("assistant", getTimeGreeting() + " Let me check your training...", true);

        const [syncResult, options] = await Promise.all([
          startupSync(),
          createAgentOptions(canUseTool),
        ]);
        ctx = syncResult;
        agentOptions = options;
      } else {
        agentOptions = await createAgentOptions(canUseTool);
      }

      if (agentOptions.systemPrompt) {
        logEvent("system", {
          subtype: "system_prompt",
          prompt: typeof agentOptions.systemPrompt === "string" ? agentOptions.systemPrompt : JSON.stringify(agentOptions.systemPrompt),
        });
      }

      const channel = createMessageChannel<SDKUserMessage>();
      channelRef.current = channel;

      // Determine first prompt
      let firstPrompt: string;

      if (needsOnboarding) {
        const protocol = await fs.readFile(
          path.join(PROJECT_ROOT, "plugins/coach/commands/setup.md"), "utf-8"
        ).catch(() => "");
        firstPrompt = protocol
          ? `[Onboarding] Follow this protocol exactly:\n\n${protocol}`
          : "[Session start]";
      } else if (ctx!.sync.newRunIds.length > 0) {
        firstPrompt = formatNewRunsPrompt(ctx!);
      } else {
        // No new runs — static guidance + background LLM warmup
        const status = formatCompactStatus(ctx!);
        addMessage("assistant", status + "\n\nWhat would you like to work on? Try: \"analyze my last run\", \"what's today's workout?\", or type / for commands", true);
        firstPrompt = "[Session start — no new activities. Respond only: ready]";
        greetingIsBackground = true;
      }

      // Set up turn state for the first message
      if (!greetingIsBackground) {
        setIsProcessing(true);
        turnStateRef.current = { currentResponse: "", hadToolCall: false };
      }
      // For background warmup, turnStateRef stays null — response silently consumed
      const firstTurnComplete = new Promise<void>((resolve) => {
        turnResolveRef.current = resolve;
      });

      resetTurn();
      const firstUserUuid = logEvent("user", { message: { role: "user", content: firstPrompt } });
      setLastUserUuid(firstUserUuid);
      channel.push({
        type: "user",
        message: { role: "user", content: firstPrompt },
        parent_tool_use_id: null,
        session_id: "",
      });

      const q = query({ prompt: channel.iterable, options: agentOptions });
      queryRef.current = q;

      // Background consumer loop — runs for the entire session
      (async () => {
        try {
          const callbacks = { addMessage, setStreamingText, toolTracker };
          for await (const message of q) {
            const state = turnStateRef.current;
            if (state) {
              handleSdkMessage(message, callbacks, state);
            }

            // Turn complete — flush and signal
            if (message.type === "result") {
              if (state && state.currentResponse.trim()) {
                addMessage("assistant", state.currentResponse);
                state.currentResponse = "";
              }
              setStreamingText(null);
              setIsProcessing(false);
              turnResolveRef.current?.();
              turnResolveRef.current = null;
              turnStateRef.current = null;
            }
          }
        } catch (error) {
          logEvent("system", {
            subtype: "error",
            message: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
          });
          addMessage("system", `Session error: ${error instanceof Error ? error.message : error}`);
        }

        // Query generator ended — subprocess terminated
        setSessionEnded(true);
        setIsProcessing(false);
        if (turnResolveRef.current) {
          turnResolveRef.current();
          turnResolveRef.current = null;
        }
      })();

      setShowWelcome(false);

      if (needsOnboarding) {
        addMessage("system", "Welcome! Let me help you get started...\n", true);
      }

      if (greetingIsBackground) {
        // Background warmup — queue user messages behind it so subprocess is ready
        turnQueueRef.current = firstTurnComplete;
      } else {
        // Blocking turn (onboarding, new runs) — wait for completion
        await firstTurnComplete;
      }
    };

    init();

    return () => {
      // Cleanup on unmount
      channelRef.current?.close();
      queryRef.current?.close();
    };
  }, [hasStarted]);

  // Esc / Ctrl+C to interrupt current turn (or exit when idle)
  useInput(
    (input, key) => {
      const isCtrlC = key.ctrl && input === "c";
      if (isProcessing && queryRef.current) {
        if (key.escape || isCtrlC) {
          queryRef.current.interrupt();
        }
      } else if (isCtrlC && !isProcessing) {
        // Idle — Ctrl+C exits the app
        channelRef.current?.close();
        exit();
      }
    },
    { isActive: !pendingQuestion }
  );

  const doStreamResponse = async (prompt: string, attachments?: FileAttachment[]) => {
    if (sessionEnded || !channelRef.current) return;

    setIsProcessing(true);
    toolTracker.reset();
    setStreamingText(null);

    const state: MessageHandlerState = { currentResponse: "", hadToolCall: false };
    turnStateRef.current = state;

    resetTurn();
    const userUuid = logEvent("user", {
      message: { role: "user", content: prompt },
      has_attachments: !!(attachments && attachments.length > 0),
    });
    setLastUserUuid(userUuid);

    // Build the SDKUserMessage
    let content: any;
    if (attachments && attachments.length > 0) {
      content = buildContentBlocks(prompt, attachments);
    } else {
      content = prompt;
    }

    const message: SDKUserMessage = {
      type: "user",
      message: { role: "user", content },
      parent_tool_use_id: null,
      session_id: getCurrentSessionId() ?? "",
    };

    // Create a promise that resolves when this turn completes
    const turnComplete = new Promise<void>((resolve) => {
      turnResolveRef.current = resolve;
    });

    // Push the message into the channel
    channelRef.current.push(message);

    // Wait for the turn to complete (result message received)
    await turnComplete;

    // Clean up any dangling question prompt
    if (questionResolverRef.current) {
      questionResolverRef.current({ behavior: "deny", message: "Turn ended" });
      questionResolverRef.current = null;
      questionInputRef.current = null;
      setPendingQuestion(null);
    }
  };

  // Serialized wrapper — prevents concurrent calls from corrupting turn refs
  const streamResponse = (prompt: string, attachments?: FileAttachment[]) => {
    // If a background turn (greeting) is active, interrupt it so the
    // queue drains faster and the user's message processes immediately
    if (turnStateRef.current && !isProcessing && queryRef.current) {
      queryRef.current.interrupt();
    }
    const next = turnQueueRef.current.then(() => doStreamResponse(prompt, attachments));
    turnQueueRef.current = next.catch(() => {}); // swallow errors so the queue doesn't stall
    return next;
  };

  const handleSubmit = async (value: string) => {
    if (isProcessing || sessionEnded) return;

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
          channelRef.current?.close();
          setTimeout(() => exit(), 500);
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
          addMessage("system", "Profile reset. Strava data preserved. Send a message to restart onboarding.");
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
        <ActiveToolsBar tools={toolTracker.activeTools} elapsed={elapsed} />
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
        <Box borderStyle="round" borderColor={isProcessing ? "gray" : sessionEnded ? "red" : "cyan"} paddingX={1}>
          <Text color="cyan" bold>{">"} </Text>
          {sessionEnded ? (
            <Text color="red">Session ended. Restart the app to continue.</Text>
          ) : isProcessing ? (
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
      {!showWelcome && !isProcessing && !sessionEnded && (
        <Box marginTop={1}>
          <Text dimColor>
            /help for commands · /verbose to {verbose ? "hide" : "show"} debug info
          </Text>
        </Box>
      )}
    </Box>
  );
}
