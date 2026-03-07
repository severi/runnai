import { useState, useEffect, useRef, useCallback } from "react";
import { useInput, type Key } from "ink";
import Fuse from "fuse.js";
import { commands, type Command } from "../commands.js";

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

export { isSlashCommand, fuse };

export interface CommandSuggestions {
  suggestions: Command[];
  selectedSuggestion: number;
  setSuggestions: (s: Command[]) => void;
  setSelectedSuggestion: (n: number | ((prev: number) => number)) => void;
}

export function useCommandSuggestions(
  input: string,
  isProcessing: boolean,
  pendingQuestion: unknown | null,
  setInput: (s: string) => void,
): CommandSuggestions {
  const [suggestions, setSuggestions] = useState<Command[]>([]);
  const [selectedSuggestion, setSelectedSuggestion] = useState(0);
  const prevSuggestionsLen = useRef(0);

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

  return { suggestions, selectedSuggestion, setSuggestions, setSelectedSuggestion };
}
