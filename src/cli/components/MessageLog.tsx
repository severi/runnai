import React from "react";
import { Box, Text, Static } from "ink";
import { ChatBubble } from "./ChatBubble.js";
import type { Message } from "../commands.js";

export interface MessageItem {
  id: number;
  message: Message;
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

/**
 * The committed message log — every finalized message, rendered once into
 * <Static> scrollback.
 *
 * CRITICAL: the explicit width on <Static> must stay. Static positions itself
 * absolutely, so it sizes to its CONTENT, not the terminal. Without a width,
 * each message collapses to its longest natural line, and any table inside
 * gets crushed into ~20-char columns — flex cells shrink to one word (or one
 * LETTER) per line and row-stretch pads the rest, exploding a 9-line message
 * into 300+ mostly-blank lines. Regression-tested in MessageLog.test.tsx.
 */
export function MessageLog({ items }: { items: MessageItem[] }) {
  return (
    <Static style={{ width: "100%" }} items={items}>
      {(item) => (
        <Box key={item.id} flexDirection="column">
          {renderMessage(item)}
        </Box>
      )}
    </Static>
  );
}
