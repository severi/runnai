import React from "react";
import { Box, Text } from "ink";
import { MarkdownText } from "./MarkdownText.js";

interface ChatBubbleProps {
  role: "user" | "assistant";
  children: string;
}

export function ChatBubble({ role, children }: ChatBubbleProps) {
  const isUser = role === "user";

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold color={isUser ? "blue" : "green"}>
        {isUser ? "You" : "Coach"}
      </Text>
      {isUser ? (
        <Box marginLeft={1}>
          <Text wrap="wrap" backgroundColor="#333333">{children}</Text>
        </Box>
      ) : (
        <Box marginLeft={1} flexDirection="column">
          <MarkdownText>{children}</MarkdownText>
        </Box>
      )}
    </Box>
  );
}
