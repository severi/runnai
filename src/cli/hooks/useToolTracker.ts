import { useState, useRef, useCallback } from "react";

export interface ActiveTool {
  id: string;
  index: number;
  name: string;
  keyArg: string;
  startTime: number;
}

function extractKeyArg(input: Record<string, unknown>): string {
  const filePath = input.file_path || input.path;
  if (typeof filePath === "string") {
    return filePath.split("/").slice(-2).join("/");
  }
  const q = input.query || input.sql;
  if (typeof q === "string") {
    return q.length > 50 ? q.slice(0, 50) + "..." : q;
  }
  const key = input.key || input.name || input.topic;
  if (typeof key === "string") {
    return key.length > 50 ? key.slice(0, 50) + "..." : key;
  }
  for (const v of Object.values(input)) {
    if (typeof v === "string" && v.length > 0) {
      return v.length > 50 ? v.slice(0, 50) + "..." : v;
    }
  }
  return "";
}

export function formatToolInput(input: Record<string, unknown>): string {
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
}

export interface ToolTracker {
  activeTools: ActiveTool[];
  startTool(toolUseId: string, name: string, input: Record<string, unknown>): ActiveTool;
  completeTool(toolUseId: string): { tool: ActiveTool | undefined; durationMs: number };
  reset(): void;
}

export function useToolTracker(): ToolTracker {
  const [activeTools, setActiveTools] = useState<ActiveTool[]>([]);
  const mapRef = useRef(new Map<string, ActiveTool>());
  const countRef = useRef(0);

  const startTool = useCallback((toolUseId: string, name: string, input: Record<string, unknown>): ActiveTool => {
    countRef.current++;
    const tool: ActiveTool = {
      id: toolUseId,
      index: countRef.current,
      name: name.replace("mcp__runnai__", ""),
      keyArg: extractKeyArg(input),
      startTime: Date.now(),
    };
    mapRef.current.set(toolUseId, tool);
    setActiveTools([...mapRef.current.values()]);
    return tool;
  }, []);

  const completeTool = useCallback((toolUseId: string): { tool: ActiveTool | undefined; durationMs: number } => {
    const tool = mapRef.current.get(toolUseId) ?? mapRef.current.values().next().value ?? undefined;
    const durationMs = tool ? Date.now() - tool.startTime : 0;
    if (tool) {
      mapRef.current.delete(tool.id);
      setActiveTools([...mapRef.current.values()]);
    }
    return { tool, durationMs };
  }, []);

  const reset = useCallback(() => {
    countRef.current = 0;
    mapRef.current.clear();
    setActiveTools([]);
  }, []);

  return { activeTools, startTool, completeTool, reset };
}
