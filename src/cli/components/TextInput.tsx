import React, { useState, useEffect, useRef } from "react";
import { Text, useInput } from "ink";

interface TextInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit?: (value: string) => void;
  placeholder?: string;
  focus?: boolean;
  showCursor?: boolean;
}

function prevWordBoundary(value: string, pos: number): number {
  if (pos <= 0) return 0;
  let i = pos;
  // Skip spaces going left
  while (i > 0 && value[i - 1] === " ") i--;
  // Skip non-spaces going left
  while (i > 0 && value[i - 1] !== " ") i--;
  return i;
}

function nextWordBoundary(value: string, pos: number): number {
  const len = value.length;
  if (pos >= len) return len;
  let i = pos;
  // Skip non-spaces going right
  while (i < len && value[i] !== " ") i++;
  // Skip spaces going right
  while (i < len && value[i] === " ") i++;
  return i;
}

export function TextInput({
  value,
  onChange,
  onSubmit,
  placeholder = "",
  focus = true,
  showCursor = true,
}: TextInputProps) {
  // Display state — drives rendering, always consistent with each other
  const [displayValue, setDisplayValue] = useState(value);
  const [displayCursor, setDisplayCursor] = useState(value.length);

  // Refs — synchronous source of truth for the useInput handler.
  // NEVER overwritten during render. Only updated by the handler and
  // the external-sync effect.
  const valueRef = useRef(value);
  const cursorRef = useRef(value.length);

  // Set when the handler calls onChange; cleared by the sync effect.
  // While true, the effect knows our change is propagating through React
  // and skips overwriting our refs with a stale prop.
  const selfUpdatedRef = useRef(false);

  // Sync from external value changes (tab completion, escape, clear).
  // Only acts when the handler HASN'T recently updated — if selfUpdatedRef
  // is true, the arriving prop is just our own onChange echoing back.
  useEffect(() => {
    if (selfUpdatedRef.current) {
      selfUpdatedRef.current = false;
      return;
    }
    if (value !== valueRef.current) {
      valueRef.current = value;
      cursorRef.current = value.length;
      setDisplayValue(value);
      setDisplayCursor(value.length);
    }
  }, [value]);

  useInput(
    (input, key) => {
      // Pass through to parent useInput handlers
      if (
        key.upArrow ||
        key.downArrow ||
        (key.ctrl && input === "c") ||
        key.tab ||
        (key.shift && key.tab) ||
        key.escape
      ) {
        return;
      }

      if (key.return) {
        onSubmit?.(valueRef.current);
        return;
      }

      // Read from refs — always the latest state, even between renders
      const oldValue = valueRef.current;
      let nextCursor = cursorRef.current;
      let nextValue = oldValue;

      // --- Readline keybindings ---

      if (key.ctrl && input === "a") {
        // Ctrl+A: start of line
        nextCursor = 0;
      } else if (key.ctrl && input === "e") {
        // Ctrl+E: end of line
        nextCursor = nextValue.length;
      } else if (key.ctrl && input === "b") {
        // Ctrl+B: back one char
        nextCursor = Math.max(0, nextCursor - 1);
      } else if (key.ctrl && input === "f") {
        // Ctrl+F: forward one char
        nextCursor = Math.min(nextValue.length, nextCursor + 1);
      } else if (key.meta && input === "b") {
        // Alt+B: back one word
        nextCursor = prevWordBoundary(nextValue, nextCursor);
      } else if (key.meta && input === "f") {
        // Alt+F: forward one word
        nextCursor = nextWordBoundary(nextValue, nextCursor);
      } else if (key.ctrl && input === "k") {
        // Ctrl+K: kill to end of line
        nextValue = nextValue.slice(0, nextCursor);
      } else if (key.ctrl && input === "u") {
        // Ctrl+U: kill to start of line
        nextValue = nextValue.slice(nextCursor);
        nextCursor = 0;
      } else if (key.ctrl && input === "w") {
        // Ctrl+W: delete word backward
        const boundary = prevWordBoundary(nextValue, nextCursor);
        nextValue = nextValue.slice(0, boundary) + nextValue.slice(nextCursor);
        nextCursor = boundary;
      } else if (key.meta && input === "d") {
        // Alt+D: delete word forward
        const boundary = nextWordBoundary(nextValue, nextCursor);
        nextValue = nextValue.slice(0, nextCursor) + nextValue.slice(boundary);
      } else if (key.ctrl && input === "d") {
        // Ctrl+D: delete char forward
        if (nextCursor < nextValue.length) {
          nextValue = nextValue.slice(0, nextCursor) + nextValue.slice(nextCursor + 1);
        }
      } else if (key.leftArrow) {
        if (showCursor) {
          nextCursor = key.meta
            ? prevWordBoundary(nextValue, nextCursor)
            : Math.max(0, nextCursor - 1);
        }
      } else if (key.rightArrow) {
        if (showCursor) {
          nextCursor = key.meta
            ? nextWordBoundary(nextValue, nextCursor)
            : Math.min(nextValue.length, nextCursor + 1);
        }
      } else if (key.backspace || key.delete) {
        if (nextCursor > 0) {
          nextValue =
            nextValue.slice(0, nextCursor - 1) + nextValue.slice(nextCursor);
          nextCursor = nextCursor - 1;
        }
      } else if (input && !key.ctrl && !key.meta) {
        // Regular character(s) — includes paste
        nextValue =
          nextValue.slice(0, nextCursor) + input + nextValue.slice(nextCursor);
        nextCursor = nextCursor + input.length;
      }

      nextCursor = Math.max(0, Math.min(nextCursor, nextValue.length));

      // Update refs synchronously — next keystroke sees correct state
      // even if React hasn't re-rendered yet
      cursorRef.current = nextCursor;
      valueRef.current = nextValue;

      // Update display state (React batches these)
      setDisplayCursor(nextCursor);
      setDisplayValue(nextValue);

      // Notify parent if value changed
      if (nextValue !== oldValue) {
        selfUpdatedRef.current = true;
        onChange(nextValue);
      }
    },
    { isActive: focus }
  );

  // --- Render from display state (never from prop) ---

  if (!displayValue && placeholder) {
    if (showCursor && focus) {
      return (
        <Text>
          <Text inverse>{placeholder[0] || " "}</Text>
          <Text dimColor>{placeholder.slice(1)}</Text>
        </Text>
      );
    }
    return <Text dimColor>{placeholder}</Text>;
  }

  if (!showCursor || !focus) {
    return <Text>{displayValue}</Text>;
  }

  const before = displayValue.slice(0, displayCursor);
  const cursorChar =
    displayCursor < displayValue.length ? displayValue[displayCursor] : " ";
  const after =
    displayCursor < displayValue.length ? displayValue.slice(displayCursor + 1) : "";

  return (
    <Text>
      {before}
      <Text inverse>{cursorChar}</Text>
      {after}
    </Text>
  );
}
