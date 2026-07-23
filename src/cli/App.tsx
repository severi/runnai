import React, { useState, useEffect, useRef, useCallback } from "react";
import { Box, Text, useInput, useApp } from "ink";
import * as fs from "fs/promises";
import * as path from "path";
import { query, startup, type SDKUserMessage, type Query, type WarmQuery } from "@anthropic-ai/claude-agent-sdk";
import { createAgentOptions } from "../agent.js";
import { getDataDir, PROJECT_ROOT } from "../utils/paths.js";
import { getCurrentSessionId, setSessionId, loadPersistedSessionId } from "../utils/session.js";
import { appendChatMessage, loadChatHistory, resetChatHistory } from "../utils/chat-history.js";
import { detectAndReadFiles, buildContentBlocks, type FileAttachment } from "../utils/file-attachments.js";
import { startupSync, formatNewRunsPrompt, formatCompactStatus, formatStartupGreeting } from "../utils/startup-sync.js";
import { logEvent } from "../utils/logger.js";
import { commands, getCommandByName, type CommandContext, type Message } from "./commands.js";
import { MessageLog, type MessageItem } from "./components/MessageLog.js";
import { ChatInputArea } from "./components/ChatInputArea.js";
import { ContextBar } from "./components/ContextBar.js";
import { QuestionPrompt, type AskQuestion } from "./components/QuestionPrompt.js";
import type { PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import { useToolTracker, type ActiveTool } from "./hooks/useToolTracker.js";
import { isSlashCommand, fuse } from "./hooks/useCommandSuggestions.js";
import { handleSdkMessage, setLastUserUuid, resetTurn, type MessageHandlerState, type ContextUsage } from "./handleSdkMessage.js";
import { createMessageChannel, type MessageChannel } from "../utils/message-channel.js";

const CONTEXT_FILE = path.join(getDataDir(), "athlete/CONTEXT.md");

function getTimeGreeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return "Good morning!";
  if (hour < 17) return "Good afternoon!";
  return "Good evening!";
}

// Event-driven only — NO clock-driven animation. The live region must not
// change frames on a timer: Ink writes to stdout whenever a frame changes, and
// any stdout write makes the terminal snap its viewport to the bottom, which
// made it impossible to scroll up and read while the agent was thinking or a
// tool was running. This bar updates only on real events (tool start/finish,
// progress summaries); each tool's duration is shown on its completion line.
function ActiveToolsBar({ tools }: { tools: ActiveTool[] }) {
  if (tools.length === 0) return null;

  return (
    <Box flexDirection="column">
      {tools.map((tool) => (
        <Box key={tool.id} flexDirection="column">
          <Text color="cyan" dimColor>  ⏺ [{tool.index}] {tool.name}{tool.keyArg ? `: ${tool.keyArg}` : ""}</Text>
          {tool.summary && (
            <Box marginLeft={5}>
              <Text color="gray" dimColor italic>{tool.summary}</Text>
            </Box>
          )}
        </Box>
      ))}
    </Box>
  );
}

// Height-bounded live preview of the streaming reply. The live region must
// always fit the terminal viewport (Ink erases/redraws it with cursor moves
// that can't reach above the visible screen), so we show only a dim tail of
// the in-flight text. The full formatted reply lands in Static on flush.
const STREAM_TAIL_CHARS = 600;
const STREAM_TAIL_LINES = 8;

function StreamingTail({ text }: { text: string }) {
  let tail = text.length > STREAM_TAIL_CHARS ? text.slice(-STREAM_TAIL_CHARS) : text;
  if (tail !== text) {
    // Start at a line boundary so we don't render a sliced word/markdown fragment
    const nl = tail.indexOf("\n");
    if (nl !== -1 && nl < STREAM_TAIL_CHARS / 2) tail = tail.slice(nl + 1);
  }
  const lines = tail.split("\n");
  const clipped = tail !== text || lines.length > STREAM_TAIL_LINES;
  const shown = lines.slice(-STREAM_TAIL_LINES).join("\n");
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold color="green">Coach</Text>
      <Box marginLeft={1} flexDirection="column">
        {clipped && <Text dimColor>…</Text>}
        <Text dimColor wrap="wrap">{shown}</Text>
      </Box>
    </Box>
  );
}

export default function App({ resume = false }: { resume?: boolean }) {
  const { exit } = useApp();

  // Single-homed rendering: every finalized message goes straight into <Static>
  // (scrollback) and never renders in the live region. Messages are immutable
  // once created, so there is nothing to "move" later — and moving is exactly
  // what broke: Static renders at full terminal width while the live region
  // renders inside the padded root box, so the same message wrapped to a
  // different height in each region and the erase/redraw math at the commit
  // frame left stray blank lines in scrollback (worst with tables, the most
  // wrap-sensitive content). The live region holds only small transient UI:
  // streaming tail, tools bar, question form, input.
  // `input` state lives in <ChatInputArea> so keystrokes don't re-render this tree.
  const [committed, setCommitted] = useState<MessageItem[]>([]);
  const [streamingText, setStreamingText] = useState<string | null>(null);
  const [debugMessages, setDebugMessages] = useState<Message[]>([]);
  const [contextUsage, setContextUsage] = useState<ContextUsage | null>(null);

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
  const warmQueryPromiseRef = useRef<Promise<WarmQuery | null> | null>(null);
  const channelRef = useRef<MessageChannel<SDKUserMessage> | null>(null);
  const turnResolveRef = useRef<(() => void) | null>(null);
  const turnStateRef = useRef<MessageHandlerState | null>(null);
  // Serialization queue — prevents concurrent streamResponse calls from corrupting turn refs
  const turnQueueRef = useRef<Promise<void>>(Promise.resolve());

  // Extracted hooks
  const toolTracker = useToolTracker();

  const addMessage = useCallback((role: Message["role"], content: string) => {
    if (role === "tool" || role === "debug" || role === "error") {
      setDebugMessages((prev) => [...prev.slice(-100), { role, content }]);
      return;
    }
    // Persist the visible transcript so --resume can replay it
    if (role === "user" || role === "assistant") appendChatMessage(role, content);
    const item: MessageItem = { id: nextIdRef.current++, message: { role, content } };
    setCommitted((prev) => [...prev, item]);
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

      // Resume: seed the session ID BEFORE createAgentOptions() — that's where
      // the SDK `resume:` option reads it. The subprocess reloads the actual
      // conversation state; we only replay the visible transcript.
      if (resume) {
        const prevId = await loadPersistedSessionId();
        if (prevId) {
          setSessionId(prevId);
          const history = await loadChatHistory();
          if (history.length > 0) {
            setCommitted((prev) => [
              ...prev,
              ...history.map((m): MessageItem => ({ id: nextIdRef.current++, message: m })),
            ]);
          }
          setShowWelcome(false);
          addMessage("system", `Resumed previous session (${history.length} earlier messages).`);
        } else {
          addMessage("system", "No previous session found — starting fresh.");
        }
      } else {
        // Fresh session — the transcript on disk must match the live SDK session
        await resetChatHistory();
      }

      // Check onboarding status early — needed to decide startup path
      let needsOnboarding = false;
      try {
        const contextContent = await fs.readFile(CONTEXT_FILE, "utf-8");
        needsOnboarding = contextContent.includes("[not set]") || contextContent.includes("[No goals set yet]");
      } catch {
        needsOnboarding = true;
      }

      // Build agent options first (fast — reads system prompt + recent-summary files).
      // Then pre-warm the subprocess with those options in parallel with startupSync (slow — Strava API).
      const agentOptions = await createAgentOptions(canUseTool);
      const warmQueryPromise: Promise<WarmQuery | null> = startup({ options: agentOptions }).catch(() => null);
      warmQueryPromiseRef.current = warmQueryPromise;

      // For returning users: show generic greeting immediately, then sync in parallel
      let ctx: Awaited<ReturnType<typeof startupSync>>;
      let greetingIsBackground = false;

      if (!needsOnboarding) {
        setShowWelcome(false);
        addMessage("assistant", getTimeGreeting() + " Let me check your training...");
        ctx = await startupSync();
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
      } else if (ctx!.fitnessDrift?.should_prompt) {
        // No new runs but fitness drift detected — coach must surface it proactively
        const status = formatCompactStatus(ctx!);
        addMessage("assistant", status + "\n\nFitness drift detected — checking your zones...");
        firstPrompt = formatStartupGreeting(ctx!);
      } else {
        // No new runs and no drift — static guidance + background LLM warmup
        const status = formatCompactStatus(ctx!);
        addMessage("assistant", status + "\n\nWhat would you like to work on? Try: \"analyze my last run\", \"what's today's workout?\", or type / for commands");
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

      const warm = await warmQueryPromise;
      const q: Query = warm
        ? warm.query(channel.iterable)
        : query({ prompt: channel.iterable, options: agentOptions });
      queryRef.current = q;

      // Background consumer loop — runs for the entire session
      (async () => {
        try {
          const callbacks = {
            addMessage,
            setStreamingText,
            toolTracker,
            onRequesting: () => setIsProcessing(true),
            onUsage: setContextUsage,
          };
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
        addMessage("system", "Welcome! Let me help you get started...\n");
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
      // Close the WarmQuery if we unmounted before handing it off to query().
      // The .then() fires whenever the promise resolves — including after unmount —
      // so a subprocess that booted late still gets closed.
      warmQueryPromiseRef.current?.then((w) => {
        if (w && !queryRef.current) w.close();
      }).catch(() => {});
    };
  }, [hasStarted]);

  // Esc / Ctrl+C while processing → interrupt the current turn.
  // Idle Ctrl+C handling (clear input vs. exit) lives in <ChatInputArea>.
  useInput(
    (keyInput, key) => {
      const isCtrlC = key.ctrl && keyInput === "c";
      if ((key.escape || isCtrlC) && queryRef.current) {
        queryRef.current.interrupt();
      }
    },
    { isActive: !pendingQuestion && isProcessing },
  );

  const handleExit = useCallback(() => {
    channelRef.current?.close();
    exit();
  }, [exit]);

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

  const handleSubmit = useCallback(async (value: string) => {
    // ChatInputArea has already resolved suggestions and cleared its own input;
    // we just receive the final command/text.
    if (isProcessing || sessionEnded || !value.trim()) return;

    setShowWelcome(false);

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
          return;
        }

        if (command.name === "help") {
          let helpText = "\nAvailable Commands:\n";
          commands.forEach((cmd) => {
            helpText += `  /${cmd.name} — ${cmd.description}\n`;
          });
          addMessage("system", helpText);
          return;
        }

        const context: CommandContext = {
          print: (text) => addMessage("system", text),
          streamResponse,
          getMessages: () => committed.map((i) => i.message),
          getQuery: () => queryRef.current,
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
  }, [
    isProcessing,
    sessionEnded,
    addMessage,
    verbose,
    committed,
    exit,
  ]);

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
      <MessageLog items={committed} />

      {/* Live streaming preview — a height-bounded tail, NOT the full text.
          The full reply would make the live region taller than the viewport and
          recreate the erase/redraw artifacts; the complete formatted reply is
          committed to Static the moment the text block finishes. */}
      {streamingText && <StreamingTail text={streamingText} />}

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
        <ActiveToolsBar tools={toolTracker.activeTools} />
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

      {/* Input area — owns its own state so keystrokes don't re-render this tree */}
      <ChatInputArea
        isProcessing={isProcessing}
        hasPendingQuestion={pendingQuestion !== null}
        sessionEnded={sessionEnded}
        showWelcome={showWelcome}
        verbose={verbose}
        onSubmit={handleSubmit}
        onExit={handleExit}
      />

      {/* Context window usage bar — shows after the first turn completes */}
      {contextUsage && (
        <ContextBar
          used={
            contextUsage.cacheReadTokens +
            contextUsage.cacheCreationTokens +
            contextUsage.inputTokens
          }
          total={1_000_000}
        />
      )}
    </Box>
  );
}
