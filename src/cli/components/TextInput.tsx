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
  while (i > 0 && value[i - 1] === " ") i--;
  while (i > 0 && value[i - 1] !== " ") i--;
  return i;
}

function nextWordBoundary(value: string, pos: number): number {
  const len = value.length;
  if (pos >= len) return len;
  let i = pos;
  while (i < len && value[i] !== " ") i++;
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
  const [cursor, setCursor] = useState(value.length);

  // Refs for synchronous access in useInput handler
  const valueRef = useRef(value);
  const cursorRef = useRef(value.length);

  // Tracks the last value we emitted via onChange, so we can distinguish
  // our own changes echoing back from external changes (tab complete, clear)
  const lastEmittedRef = useRef(value);

  // Sync from prop changes
  useEffect(() => {
    valueRef.current = value;

    if (value !== lastEmittedRef.current) {
      // External change (tab completion, escape, clear)
      cursorRef.current = value.length;
      setCursor(value.length);
    }

    lastEmittedRef.current = value;
  }, [value]);

  useInput(
    (input, key) => {
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

      const oldValue = valueRef.current;
      let nextCursor = cursorRef.current;
      let nextValue = oldValue;

      if (key.ctrl && input === "a") {
        nextCursor = 0;
      } else if (key.ctrl && input === "e") {
        nextCursor = nextValue.length;
      } else if (key.ctrl && input === "b") {
        nextCursor = Math.max(0, nextCursor - 1);
      } else if (key.ctrl && input === "f") {
        nextCursor = Math.min(nextValue.length, nextCursor + 1);
      } else if (key.meta && input === "b") {
        nextCursor = prevWordBoundary(nextValue, nextCursor);
      } else if (key.meta && input === "f") {
        nextCursor = nextWordBoundary(nextValue, nextCursor);
      } else if (key.ctrl && input === "k") {
        nextValue = nextValue.slice(0, nextCursor);
      } else if (key.ctrl && input === "u") {
        nextValue = nextValue.slice(nextCursor);
        nextCursor = 0;
      } else if (key.ctrl && input === "w") {
        const boundary = prevWordBoundary(nextValue, nextCursor);
        nextValue = nextValue.slice(0, boundary) + nextValue.slice(nextCursor);
        nextCursor = boundary;
      } else if (key.meta && input === "d") {
        const boundary = nextWordBoundary(nextValue, nextCursor);
        nextValue = nextValue.slice(0, nextCursor) + nextValue.slice(boundary);
      } else if (key.ctrl && input === "d") {
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
        nextValue =
          nextValue.slice(0, nextCursor) + input + nextValue.slice(nextCursor);
        nextCursor = nextCursor + input.length;
      }

      nextCursor = Math.max(0, Math.min(nextCursor, nextValue.length));

      // Update refs synchronously — next keystroke sees correct state
      cursorRef.current = nextCursor;
      valueRef.current = nextValue;
      setCursor(nextCursor);

      if (nextValue !== oldValue) {
        lastEmittedRef.current = nextValue;
        onChange(nextValue);
      }
    },
    { isActive: focus }
  );

  // Render from value prop + cursor state (clamped for safety)
  const effectiveCursor = Math.min(cursor, value.length);

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

  const before = value.slice(0, effectiveCursor);
  const cursorChar =
    effectiveCursor < value.length ? value[effectiveCursor] : " ";
  const after =
    effectiveCursor < value.length ? value.slice(effectiveCursor + 1) : "";

  return (
    <Text>
      {before}
      <Text inverse>{cursorChar}</Text>
      {after}
    </Text>
  );
}
