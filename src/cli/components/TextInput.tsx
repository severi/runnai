import React, { useState, useEffect } from "react";
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
  const [cursorOffset, setCursorOffset] = useState(value.length);

  // Clamp cursor when value changes externally
  useEffect(() => {
    setCursorOffset((prev) => Math.min(prev, value.length));
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
        onSubmit?.(value);
        return;
      }

      let nextCursor = cursorOffset;
      let nextValue = value;

      // --- Readline keybindings ---

      if (key.ctrl && input === "a") {
        // Ctrl+A: start of line
        nextCursor = 0;
      } else if (key.ctrl && input === "e") {
        // Ctrl+E: end of line
        nextCursor = value.length;
      } else if (key.ctrl && input === "b") {
        // Ctrl+B: back one char
        nextCursor = Math.max(0, cursorOffset - 1);
      } else if (key.ctrl && input === "f") {
        // Ctrl+F: forward one char
        nextCursor = Math.min(value.length, cursorOffset + 1);
      } else if (key.meta && input === "b") {
        // Alt+B: back one word
        nextCursor = prevWordBoundary(value, cursorOffset);
      } else if (key.meta && input === "f") {
        // Alt+F: forward one word
        nextCursor = nextWordBoundary(value, cursorOffset);
      } else if (key.ctrl && input === "k") {
        // Ctrl+K: kill to end of line
        nextValue = value.slice(0, cursorOffset);
      } else if (key.ctrl && input === "u") {
        // Ctrl+U: kill to start of line
        nextValue = value.slice(cursorOffset);
        nextCursor = 0;
      } else if (key.ctrl && input === "w") {
        // Ctrl+W: delete word backward
        const boundary = prevWordBoundary(value, cursorOffset);
        nextValue = value.slice(0, boundary) + value.slice(cursorOffset);
        nextCursor = boundary;
      } else if (key.meta && input === "d") {
        // Alt+D: delete word forward
        const boundary = nextWordBoundary(value, cursorOffset);
        nextValue = value.slice(0, cursorOffset) + value.slice(boundary);
      } else if (key.ctrl && input === "d") {
        // Ctrl+D: delete char forward
        if (cursorOffset < value.length) {
          nextValue = value.slice(0, cursorOffset) + value.slice(cursorOffset + 1);
        }
      } else if (key.leftArrow) {
        if (showCursor) {
          nextCursor = key.meta
            ? prevWordBoundary(value, cursorOffset)
            : Math.max(0, cursorOffset - 1);
        }
      } else if (key.rightArrow) {
        if (showCursor) {
          nextCursor = key.meta
            ? nextWordBoundary(value, cursorOffset)
            : Math.min(value.length, cursorOffset + 1);
        }
      } else if (key.backspace || key.delete) {
        if (cursorOffset > 0) {
          nextValue =
            value.slice(0, cursorOffset - 1) + value.slice(cursorOffset);
          nextCursor = cursorOffset - 1;
        }
      } else if (input && !key.ctrl && !key.meta) {
        // Regular character(s) — includes paste
        nextValue =
          value.slice(0, cursorOffset) + input + value.slice(cursorOffset);
        nextCursor = cursorOffset + input.length;
      }

      nextCursor = Math.max(0, Math.min(nextCursor, nextValue.length));
      setCursorOffset(nextCursor);

      if (nextValue !== value) {
        onChange(nextValue);
      }
    },
    { isActive: focus }
  );

  // --- Render ---

  if (!value && placeholder) {
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
    return <Text>{value}</Text>;
  }

  const before = value.slice(0, cursorOffset);
  const cursorChar =
    cursorOffset < value.length ? value[cursorOffset] : " ";
  const after =
    cursorOffset < value.length ? value.slice(cursorOffset + 1) : "";

  return (
    <Text>
      {before}
      <Text inverse>{cursorChar}</Text>
      {after}
    </Text>
  );
}
