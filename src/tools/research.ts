import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import * as fs from "fs/promises";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "../..");
const RESEARCH_DIR = path.join(PROJECT_ROOT, "data/research");
const TOPICS_DIR = path.join(RESEARCH_DIR, "topics");
const INDEX_FILE = path.join(RESEARCH_DIR, "index.md");

const CACHE_MAX_AGE_DAYS = 30;

interface CacheMetadata {
  topic: string;
  lastUpdated: string;
  sources: string[];
}

async function ensureDirectories(): Promise<void> {
  await fs.mkdir(TOPICS_DIR, { recursive: true });
}

function sanitizeFilename(topic: string): string {
  return topic
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

async function getCacheMetadata(topic: string): Promise<CacheMetadata | null> {
  const filename = `${sanitizeFilename(topic)}.md`;
  const filePath = path.join(TOPICS_DIR, filename);

  try {
    const content = await fs.readFile(filePath, "utf-8");
    const lastUpdatedMatch = content.match(/\*Last updated: (\d{4}-\d{2}-\d{2})/);
    const sourcesMatch = content.match(/## Key Sources\n([\s\S]*?)(?=\n## |$)/);

    if (lastUpdatedMatch) {
      const lastUpdated = lastUpdatedMatch[1];
      const sources: string[] = [];
      if (sourcesMatch) {
        const sourcesText = sourcesMatch[1];
        const sourceLines = sourcesText.match(/- .+/g) || [];
        sources.push(...sourceLines.map((s) => s.replace(/^- /, "")));
      }
      return { topic, lastUpdated, sources };
    }
  } catch {
    // File doesn't exist
  }

  return null;
}

async function isCacheValid(topic: string): Promise<boolean> {
  const metadata = await getCacheMetadata(topic);
  if (!metadata) return false;

  const lastUpdated = new Date(metadata.lastUpdated);
  const ageInDays = (Date.now() - lastUpdated.getTime()) / (1000 * 60 * 60 * 24);
  return ageInDays < CACHE_MAX_AGE_DAYS;
}

async function readCachedResearch(topic: string): Promise<string | null> {
  const filename = `${sanitizeFilename(topic)}.md`;
  const filePath = path.join(TOPICS_DIR, filename);

  try {
    return await fs.readFile(filePath, "utf-8");
  } catch {
    return null;
  }
}

async function saveResearch(topic: string, content: string, sources: string[]): Promise<void> {
  await ensureDirectories();

  const filename = `${sanitizeFilename(topic)}.md`;
  const filePath = path.join(TOPICS_DIR, filename);
  const now = new Date().toISOString().split("T")[0];

  const markdown = `# ${topic}

## Summary
${content}

## Key Sources
${sources.map((s) => `- ${s}`).join("\n")}

## Application Notes
[How this applies to training plan creation and updates]

---
*Last updated: ${now} by researcher agent*
`;

  await fs.writeFile(filePath, markdown);
  await updateIndex();
}

async function updateIndex(): Promise<void> {
  await ensureDirectories();

  try {
    const files = await fs.readdir(TOPICS_DIR);
    const topics = files.filter((f) => f.endsWith(".md"));

    let indexContent = `# Running Science Knowledge Base\n\n## Topics\n`;

    for (const file of topics) {
      const topicName = file.replace(".md", "").replace(/-/g, " ");
      const metadata = await getCacheMetadata(topicName);
      const lastUpdated = metadata?.lastUpdated || "Unknown";
      indexContent += `- @topics/${file} - ${topicName} (updated: ${lastUpdated})\n`;
    }

    indexContent += `\n## About\nTopics are automatically updated when accessed after ${CACHE_MAX_AGE_DAYS} days.\n`;

    await fs.writeFile(INDEX_FILE, indexContent);
  } catch {
    // Ignore index update errors
  }
}

async function listTopics(): Promise<string[]> {
  await ensureDirectories();
  try {
    const files = await fs.readdir(TOPICS_DIR);
    return files.filter((f) => f.endsWith(".md")).map((f) => f.replace(".md", "").replace(/-/g, " "));
  } catch {
    return [];
  }
}

export const researchTool = tool(
  "research",
  "Search for running science information and cache it locally.",
  {
    topic: z.string().describe("The running science topic to research"),
    forceRefresh: z.boolean().optional().describe("Force a fresh search even if cached"),
    listTopics: z.boolean().optional().describe("List all cached topics"),
  },
  async ({ topic, forceRefresh = false, listTopics: shouldListTopics = false }) => {
    try {
      await ensureDirectories();

      if (shouldListTopics) {
        const topics = await listTopics();
        if (topics.length === 0) {
          return { content: [{ type: "text" as const, text: "No research topics cached yet." }] };
        }

        let result = "**Cached Research Topics:**\n\n";
        for (const t of topics) {
          const metadata = await getCacheMetadata(t);
          result += `- **${t}**`;
          if (metadata) result += ` (updated: ${metadata.lastUpdated})`;
          result += "\n";
        }

        return { content: [{ type: "text" as const, text: result }] };
      }

      if (!forceRefresh && (await isCacheValid(topic))) {
        const cached = await readCachedResearch(topic);
        if (cached) {
          return { content: [{ type: "text" as const, text: `**Using cached research:**\n\n${cached}` }] };
        }
      }

      const existingContent = await readCachedResearch(topic);
      const metadata = await getCacheMetadata(topic);

      let instructions = `**Research needed for topic: ${topic}**\n\n`;
      if (metadata) {
        instructions += `Cache is ${CACHE_MAX_AGE_DAYS}+ days old (last updated: ${metadata.lastUpdated}).\n\n`;
      } else {
        instructions += `No cached research found.\n\n`;
      }
      instructions += `Please use WebSearch/WebFetch to research this topic, then call save_research to cache findings.\n`;

      if (existingContent) {
        instructions += `\n**Previous research:**\n\n${existingContent}`;
      }

      return { content: [{ type: "text" as const, text: instructions }] };
    } catch (error) {
      return {
        content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  }
);

export const saveResearchTool = tool(
  "save_research",
  "Save research findings to the local knowledge base.",
  {
    topic: z.string().describe("The topic being saved"),
    content: z.string().describe("The research summary content"),
    sources: z.array(z.string()).describe("List of sources consulted"),
  },
  async ({ topic, content, sources }) => {
    try {
      await saveResearch(topic, content, sources);
      return { content: [{ type: "text" as const, text: `Saved research on "${topic}" with ${sources.length} sources.` }] };
    } catch (error) {
      return {
        content: [{ type: "text" as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  }
);
