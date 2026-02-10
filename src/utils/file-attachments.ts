import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";

export interface FileAttachment {
  path: string;
  filename: string;
  mediaType: string;
  base64Data: string;
}

// Content block types compatible with Anthropic API (defined inline since
// @anthropic-ai/sdk is bundled inside the agent SDK and not directly importable)
type TextBlock = { type: "text"; text: string };
type ImageBlock = {
  type: "image";
  source: { type: "base64"; media_type: string; data: string };
};
type DocumentBlock = {
  type: "document";
  source: { type: "base64"; media_type: "application/pdf"; data: string };
};
export type ContentBlock = TextBlock | ImageBlock | DocumentBlock;

const SUPPORTED_EXTENSIONS: Record<string, string> = {
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25MB API limit

// Match absolute paths or ~/... paths with supported extensions.
// Handles: /path/to/file.pdf, ~/file.png, "/path with spaces/file.pdf",
// '/path/file.pdf', /path\ with\ spaces/file.pdf
const FILE_PATH_REGEX = new RegExp(
  // Quoted paths (double or single)
  `(?:"((?:~|/)(?:[^"]*?)\\.(${Object.keys(SUPPORTED_EXTENSIONS).map((e) => e.slice(1)).join("|")}))"` +
  `|'((?:~|/)(?:[^']*?)\\.(${Object.keys(SUPPORTED_EXTENSIONS).map((e) => e.slice(1)).join("|")}))'` +
  // Unquoted paths (spaces escaped with backslash, or no spaces)
  `|((?:~|/)(?:[^ "'\\t\\n]|\\\\ )*\\.(${Object.keys(SUPPORTED_EXTENSIONS).map((e) => e.slice(1)).join("|")})))`,
  "gi"
);

function expandHome(filePath: string): string {
  if (filePath.startsWith("~/")) {
    return path.join(os.homedir(), filePath.slice(2));
  }
  return filePath;
}

function unescapeSpaces(filePath: string): string {
  return filePath.replace(/\\ /g, " ");
}

/**
 * Detect file paths in user input, read supported files, return clean text and attachments.
 */
export async function detectAndReadFiles(
  text: string
): Promise<{ cleanText: string; attachments: FileAttachment[] }> {
  const attachments: FileAttachment[] = [];
  const pathsToRemove: string[] = [];

  // Reset regex state
  FILE_PATH_REGEX.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = FILE_PATH_REGEX.exec(text)) !== null) {
    // Extract the actual path from whichever capture group matched
    const rawPath = match[1] // double-quoted (full path incl. extension)
      ?? match[3] // single-quoted
      ?? match[5]; // unquoted

    if (!rawPath) continue;

    const resolvedPath = expandHome(unescapeSpaces(rawPath));
    const ext = path.extname(resolvedPath).toLowerCase();
    const mediaType = SUPPORTED_EXTENSIONS[ext];

    if (!mediaType) continue;

    try {
      await fs.access(resolvedPath);
      const stat = await fs.stat(resolvedPath);

      if (stat.size > MAX_FILE_SIZE) {
        // Skip oversized files — they stay in the text as-is
        continue;
      }

      const data = await fs.readFile(resolvedPath);
      attachments.push({
        path: resolvedPath,
        filename: path.basename(resolvedPath),
        mediaType,
        base64Data: data.toString("base64"),
      });

      pathsToRemove.push(match[0]);
    } catch {
      // File doesn't exist or can't be read — leave it in the text
    }
  }

  // Remove successfully attached file paths from the text
  let cleanText = text;
  for (const p of pathsToRemove) {
    cleanText = cleanText.replace(p, "").trim();
  }

  // If removing paths left the text empty, add a generic prompt
  if (!cleanText && attachments.length > 0) {
    cleanText = "Please analyze the attached file(s).";
  }

  return { cleanText, attachments };
}

/**
 * Build SDK-compatible content blocks from text and file attachments.
 */
export function buildContentBlocks(
  text: string,
  attachments: FileAttachment[]
): ContentBlock[] {
  const blocks: ContentBlock[] = [];

  // Add text block first
  if (text) {
    blocks.push({ type: "text", text });
  }

  // Add file blocks
  for (const attachment of attachments) {
    if (attachment.mediaType === "application/pdf") {
      blocks.push({
        type: "document",
        source: {
          type: "base64",
          media_type: "application/pdf",
          data: attachment.base64Data,
        },
      });
    } else {
      blocks.push({
        type: "image",
        source: {
          type: "base64",
          media_type: attachment.mediaType,
          data: attachment.base64Data,
        },
      });
    }
  }

  return blocks;
}
