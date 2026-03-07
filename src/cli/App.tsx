import React, { useState, useEffect, useRef } from "react";
import { Box, Text, Static, useInput, useApp } from "ink";
import { TextInput } from "./components/TextInput.js";
import * as fs from "fs/promises";
import * as path from "path";
import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { createAgentOptions } from "../agent.js";
import { getDataDir } from "../utils/paths.js";
import { setSessionId, clearPersistedSession, getCurrentSessionId, loadPersistedSession, appendChatMessage, loadChatHistory } from "../utils/session.js";
import { detectAndReadFiles, buildContentBlocks, type FileAttachment } from "../utils/file-attachments.js";
import { resetUsage } from "../utils/usage-tracker.js";
import { logEvent, saveSystemPrompt } from "../utils/logger.js";
import { commands, getCommandByName, type CommandContext, type Message } from "./commands.js";
import { ChatBubble } from "./components/ChatBubble.js";
import { QuestionPrompt, type AskQuestion } from "./components/QuestionPrompt.js";
import type { PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import { useElapsedTimer } from "./hooks/useElapsedTimer.js";
import { useToolTracker, type ActiveTool } from "./hooks/useToolTracker.js";
import { useCommandSuggestions, isSlashCommand, fuse } from "./hooks/useCommandSuggestions.js";
import { handleSdkMessage, type MessageHandlerState } from "./handleSdkMessage.js";

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

export default function App({ resume = false }: { resume?: boolean }) {
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
  const [hasCheckedFirstTime, setHasCheckedFirstTime] = useState(false);

  // AskUserQuestion support — deferred promise pattern
  const [pendingQuestion, setPendingQuestion] = useState<AskQuestion[] | null>(null);
  const questionResolverRef = useRef<((result: PermissionResult) => void) | null>(null);
  const questionInputRef = useRef<Record<string, unknown> | null>(null);

  const nextIdRef = useRef(0);
  const abortControllerRef = useRef<AbortController | null>(null);

  // Extracted hooks
  const elapsed = useElapsedTimer(isProcessing);
  const toolTracker = useToolTracker();
  const { suggestions, selectedSuggestion, setSuggestions, setSelectedSuggestion } =
    useCommandSuggestions(input, isProcessing, pendingQuestion, setInput);

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
    toolTracker.reset();
    setStreamingText(null);
    const state: MessageHandlerState = { currentResponse: "", hadToolCall: false };

    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    const callbacks = { addMessage, setStreamingText, toolTracker };

    try {
      const canUseTool = async (
        toolName: string,
        input: Record<string, unknown>,
        options: { signal: AbortSignal },
      ): Promise<PermissionResult> => {
        logEvent("can_use_tool", { tool: toolName, input_keys: Object.keys(input) });
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

      if (options.systemPrompt) {
        saveSystemPrompt(typeof options.systemPrompt === "string" ? options.systemPrompt : JSON.stringify(options.systemPrompt));
      }
      logEvent("user_message", { prompt: prompt.slice(0, 2000), has_attachments: !!(attachments && attachments.length > 0) });

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
          handleSdkMessage(message, callbacks, state);
        }
      } else {
        for await (const message of abortable(query({ prompt, options }), abortController.signal)) {
          handleSdkMessage(message, callbacks, state);
        }
      }
    } catch (error) {
      if (!abortController.signal.aborted) {
        logEvent("error", {
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        });
        addMessage("system", `Error: ${error instanceof Error ? error.message : error}`);
      }
    }

    if (state.currentResponse.trim()) {
      addMessage("assistant", state.currentResponse);
    }
    if (abortController.signal.aborted) {
      addMessage("status", "Cancelled");
    }

    if (questionResolverRef.current) {
      questionResolverRef.current({ behavior: "deny", message: "Session ended" });
      questionResolverRef.current = null;
      questionInputRef.current = null;
      setPendingQuestion(null);
    }

    setStreamingText(null);
    setIsProcessing(false);
    abortControllerRef.current = null;
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
