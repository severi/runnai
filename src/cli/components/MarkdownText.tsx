import React from "react";
import { Text, Box } from "ink";
import { marked, type Token, type Tokens } from "marked";

interface MarkdownTextProps {
  children: string;
}

// Parse markdown and render with Ink components
export function MarkdownText({ children }: MarkdownTextProps) {
  const tokens = marked.lexer(children);
  return (
    <Box flexDirection="column">
      {tokens.map((token, i) => renderToken(token, i))}
    </Box>
  );
}

function renderToken(token: Token, key: number): React.ReactNode {
  switch (token.type) {
    case "paragraph":
      return (
        <Text key={key} wrap="wrap">
          {renderInline((token as Tokens.Paragraph).tokens)}
        </Text>
      );

    case "heading":
      return (
        <Box key={key} marginTop={1}>
          <Text bold color="cyan" wrap="wrap">
            {renderInline((token as Tokens.Heading).tokens)}
          </Text>
        </Box>
      );

    case "list": {
      const listToken = token as Tokens.List;
      return (
        <Box key={key} flexDirection="column" marginLeft={1}>
          {listToken.items.map((item, i) => (
            <Box key={i}>
              <Text wrap="wrap">
                {listToken.ordered ? `${i + 1}. ` : "• "}
                {renderInline(item.tokens)}
              </Text>
            </Box>
          ))}
        </Box>
      );
    }

    case "code": {
      const codeToken = token as Tokens.Code;
      return (
        <Box
          key={key}
          borderStyle="single"
          borderColor="gray"
          paddingX={1}
          marginY={1}
        >
          <Text color="gray" wrap="wrap">{codeToken.text}</Text>
        </Box>
      );
    }

    case "blockquote": {
      const quoteToken = token as Tokens.Blockquote;
      return (
        <Box key={key} marginLeft={1} borderLeft borderColor="gray" paddingLeft={1}>
          <Text dimColor wrap="wrap">{renderInline(quoteToken.tokens)}</Text>
        </Box>
      );
    }

    case "hr":
      return (
        <Box key={key} marginY={1}>
          <Text dimColor>────────────────────</Text>
        </Box>
      );

    case "space":
      return null; // Skip extra whitespace

    default:
      // For unhandled types, just render the raw text
      if ("raw" in token) {
        return <Text key={key} wrap="wrap">{(token as { raw: string }).raw}</Text>;
      }
      return null;
  }
}

function renderInline(tokens?: Token[]): React.ReactNode {
  if (!tokens) return null;

  return tokens.map((token, i) => {
    switch (token.type) {
      case "strong":
        return (
          <Text key={i} bold>
            {renderInline((token as Tokens.Strong).tokens)}
          </Text>
        );

      case "em":
        return (
          <Text key={i} italic>
            {renderInline((token as Tokens.Em).tokens)}
          </Text>
        );

      case "codespan":
        return (
          <Text key={i} color="yellow">
            {(token as Tokens.Codespan).text}
          </Text>
        );

      case "link":
        return (
          <Text key={i} color="blue" underline>
            {(token as Tokens.Link).text}
          </Text>
        );

      case "text": {
        // Handle nested tokens in text (e.g., bold inside text)
        const textToken = token as Tokens.Text;
        if (textToken.tokens) {
          return <React.Fragment key={i}>{renderInline(textToken.tokens)}</React.Fragment>;
        }
        return <React.Fragment key={i}>{textToken.text}</React.Fragment>;
      }

      case "br":
        return <Text key={i}>{"\n"}</Text>;

      default:
        if ("raw" in token) {
          return <React.Fragment key={i}>{(token as { raw: string }).raw}</React.Fragment>;
        }
        return null;
    }
  });
}
