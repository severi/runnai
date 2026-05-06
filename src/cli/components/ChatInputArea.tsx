import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import { TextInput } from "./TextInput.js";
import { useCommandSuggestions } from "../hooks/useCommandSuggestions.js";
import { formatElapsed } from "../format.js";

export interface ChatInputAreaProps {
  /** True while the agent is processing a turn — input is hidden, "Thinking..." is shown. */
  isProcessing: boolean;
  /** True when an AskUserQuestion prompt is open — area renders nothing. */
  hasPendingQuestion: boolean;
  /** True after the session has ended — input replaced with terminal message. */
  sessionEnded: boolean;
  /** True when the welcome banner is showing — affects footer visibility. */
  showWelcome: boolean;
  /** Verbose debug mode is on — affects the footer hint wording. */
  verbose: boolean;
  /** Seconds elapsed since processing started. 0 when not processing. */
  elapsed: number;
  /** Called when the user submits a non-empty message (slash-command-resolved). */
  onSubmit: (value: string) => void | Promise<void>;
  /** Called when the user presses Ctrl+C with empty input. */
  onExit: () => void;
}

/**
 * Owns the input box, suggestions dropdown, and footer hint. Holding `input`
 * state here (instead of in App) means keystrokes only re-render this subtree —
 * the chat tree, streaming bubble, and debug panel above it stay untouched.
 */
export function ChatInputArea({
  isProcessing,
  hasPendingQuestion,
  sessionEnded,
  showWelcome,
  verbose,
  elapsed,
  onSubmit,
  onExit,
}: ChatInputAreaProps) {
  const [input, setInput] = useState("");
  const { suggestions, selectedSuggestion, setSuggestions } =
    useCommandSuggestions(input, isProcessing, hasPendingQuestion, setInput);

  // Ctrl+C: clear input if non-empty, exit if empty. Disabled during processing
  // (the App-level handler routes Ctrl+C to interrupt the turn instead) and
  // when a question prompt is open (QuestionPrompt owns its own input).
  useInput(
    (keyInput, key) => {
      const isCtrlC = key.ctrl && keyInput === "c";
      if (!isCtrlC) return;
      if (input.length > 0) {
        setInput("");
        setSuggestions([]);
      } else {
        onExit();
      }
    },
    { isActive: !hasPendingQuestion && !isProcessing && !sessionEnded },
  );

  const handleSubmit = (raw: string) => {
    if (isProcessing || sessionEnded) return;

    // Enter while suggestions are visible → use the highlighted command.
    let value = raw;
    if (suggestions.length > 0) {
      const selected = suggestions[selectedSuggestion];
      if (selected) value = `/${selected.name}`;
    }

    if (!value.trim()) return;

    setInput("");
    setSuggestions([]);
    onSubmit(value);
  };

  if (hasPendingQuestion) return null;

  return (
    <>
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

      {/* Input box */}
      <Box
        borderStyle="round"
        borderColor={isProcessing ? "gray" : sessionEnded ? "red" : "cyan"}
        paddingX={1}
      >
        <Text color="cyan" bold>{">"} </Text>
        {sessionEnded ? (
          <Text color="red">Session ended. Restart the app to continue.</Text>
        ) : isProcessing ? (
          <Text dimColor>
            Thinking...{elapsed > 0 ? ` (${formatElapsed(elapsed)})` : ""} · Esc to cancel
          </Text>
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
      {!showWelcome && !isProcessing && !sessionEnded && (
        <Box marginTop={1}>
          <Text dimColor>
            /help for commands · /verbose to {verbose ? "hide" : "show"} debug info
          </Text>
        </Box>
      )}
    </>
  );
}
