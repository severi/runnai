import React, { useReducer, useRef } from "react";
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

/** Index of the start of the current line (just after the previous \n, or 0). */
export function lineStart(value: string, pos: number): number {
  if (pos <= 0) return 0;
  const prev = value.lastIndexOf("\n", pos - 1);
  return prev === -1 ? 0 : prev + 1;
}

/** Index of the end of the current line (the position of the next \n, or len). */
export function lineEnd(value: string, pos: number): number {
  const next = value.indexOf("\n", pos);
  return next === -1 ? value.length : next;
}

export function TextInput({
  value,
  onChange,
  onSubmit,
  placeholder = "",
  focus = true,
  showCursor = true,
}: TextInputProps) {
  // Force re-render without any state for value/cursor.
  // Refs are the single source of truth — no stale closures, no async effects.
  const [, rerender] = useReducer((x: number) => x + 1, 0);

  const valueRef = useRef(value);
  const cursorRef = useRef(value.length);

  // Version counter: incremented on every keystroke in useInput.
  // At render time, if version hasn't changed since last render,
  // any value prop change must be external (tab completion, escape, clear).
  // If version HAS changed, the prop change is our own onChange echo — ignore it.
  const versionRef = useRef(0);
  const lastSyncedVersionRef = useRef(0);

  // --- External change detection (runs at render time, NOT in useEffect) ---
  if (versionRef.current === lastSyncedVersionRef.current) {
    // No keystrokes since last render — prop change is external
    if (value !== valueRef.current) {
      valueRef.current = value;
      cursorRef.current = value.length;
    }
  }
  lastSyncedVersionRef.current = versionRef.current;

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

      // Shift+Enter: most terminals (incl. iTerm2) send a bare LF (\n, 0x0A)
      // which Ink reports as name="enter" — distinct from plain Enter's \r.
      // Detect via the raw input byte rather than key flags since Ink does
      // not expose name="enter" through its key object.
      const isShiftEnter = input === "\n";
      // Plain Enter with kitty protocol + shift modifier also means newline.
      const isKittyShiftReturn = key.return && key.shift;

      if (key.return && !key.shift) {
        onSubmit?.(valueRef.current);
        return;
      }

      const oldValue = valueRef.current;
      let nextCursor = cursorRef.current;
      let nextValue = oldValue;

      if (isShiftEnter || isKittyShiftReturn) {
        nextValue = nextValue.slice(0, nextCursor) + "\n" + nextValue.slice(nextCursor);
        nextCursor += 1;
        versionRef.current++;
        valueRef.current = nextValue;
        cursorRef.current = nextCursor;
        rerender();
        onChange(nextValue);
        return;
      }

      if (key.ctrl && input === "a") {
        // Beginning of the current line — emacs/readline semantics. With a
        // single-line value this is identical to "beginning of input"; with
        // multi-line input, jump to just after the previous newline.
        nextCursor = lineStart(nextValue, nextCursor);
      } else if (key.ctrl && input === "e") {
        // End of the current line.
        nextCursor = lineEnd(nextValue, nextCursor);
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
          nextValue =
            nextValue.slice(0, nextCursor) + nextValue.slice(nextCursor + 1);
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
        // Count any DEL chars (\x7f) as additional backspaces — the terminal
        // batches multiple \x7f bytes in one stdin read during key repeat,
        // and Ink only parses the first as key.backspace.
        const delCount = (input.match(/\x7f/g) || []).length;
        if (delCount > 0) {
          const toDelete = Math.min(delCount, nextCursor);
          nextValue =
            nextValue.slice(0, nextCursor - toDelete) + nextValue.slice(nextCursor);
          nextCursor = nextCursor - toDelete;
        }
        // Normalize line terminators from pastes (CRLF/CR → LF) so multi-line
        // pastes preserve their line breaks. Plain Enter (single \r) is
        // handled earlier via key.return, so this only affects multi-char input.
        const normalized = input.replace(/\r\n?/g, "\n");
        // Allow printable chars, newline, and tab through the filter.
        const printable = normalized.replace(/[^\x20-\x7e\u00a0-\uffff\n\t]/g, "");
        if (printable) {
          nextValue =
            nextValue.slice(0, nextCursor) + printable + nextValue.slice(nextCursor);
          nextCursor = nextCursor + printable.length;
        }
      }

      nextCursor = Math.max(0, Math.min(nextCursor, nextValue.length));

      // Update refs synchronously — next keystroke sees correct state
      versionRef.current++;
      valueRef.current = nextValue;
      cursorRef.current = nextCursor;

      rerender();

      if (nextValue !== oldValue) {
        onChange(nextValue);
      }
    },
    { isActive: focus },
  );

  // --- Render from refs ---
  const displayValue = valueRef.current;
  const displayCursor = Math.min(cursorRef.current, displayValue.length);

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
    displayCursor < displayValue.length
      ? displayValue.slice(displayCursor + 1)
      : "";

  if (cursorChar === "\n") {
    return (
      <Text>
        {before}
        <Text inverse> </Text>
        {"\n"}
        {after}
      </Text>
    );
  }

  return (
    <Text>
      {before}
      <Text inverse>{cursorChar}</Text>
      {after}
    </Text>
  );
}
