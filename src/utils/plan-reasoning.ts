import * as fs from "fs/promises";

export const REASONING_SECTIONS = [
  "Trigger",
  "Sources consulted",
  "Constraints",
  "Decisions and rationale",
  "Key changes from previous version",
  "Open items at finalize",
] as const;

export type ReasoningSection = (typeof REASONING_SECTIONS)[number];

const REQUIRED_SECTIONS: ReasoningSection[] = [
  "Trigger",
  "Decisions and rationale",
  "Key changes from previous version",
];

const TEMPLATE_GUIDANCE: Record<ReasoningSection, string> = {
  "Trigger": "_One paragraph: what set this revision off and what was the goal._",
  "Sources consulted": "_References and research informing this revision. Bullet list._",
  "Constraints": "_Real-world things that shaped decisions: schedule, injuries, athlete preferences._",
  "Decisions and rationale": "_Narrative paragraphs/bullets per significant decision. \"We considered X but chose Y because Z.\"_",
  "Key changes from previous version": "_Bulleted, scannable summary of what's different._",
  "Open items at finalize": "_Deferred questions, things to revisit._",
};

export async function readReasoning(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, "utf-8");
  } catch {
    return "";
  }
}

export async function initReasoning(filePath: string, opts: { version: number }): Promise<void> {
  const sections = REASONING_SECTIONS.map(
    (s) => `## ${s}\n\n${TEMPLATE_GUIDANCE[s]}\n`,
  ).join("\n");
  const content = `# v${opts.version}\n\n${sections}`;
  await fs.writeFile(filePath, content);
}

export async function appendToSection(
  filePath: string,
  section: ReasoningSection,
  body: string,
): Promise<void> {
  if (!REASONING_SECTIONS.includes(section)) {
    throw new Error(`unknown reasoning section: ${section}`);
  }
  const existing = await readReasoning(filePath);
  if (!existing) throw new Error(`reasoning file does not exist: ${filePath}`);

  const heading = `## ${section}`;
  const idx = existing.indexOf(heading);
  if (idx === -1) throw new Error(`section heading not found: ${heading}`);

  // Insertion point: end of this section (right before the next "## " or end of file).
  const after = existing.indexOf("\n## ", idx + heading.length);
  const insertAt = after === -1 ? existing.length : after;

  const trimmedBefore = existing.slice(0, insertAt).replace(/\s+$/, "");
  const rest = existing.slice(insertAt);
  const next = `${trimmedBefore}\n${body}\n${rest.startsWith("\n") ? rest : "\n" + rest}`;
  await fs.writeFile(filePath, next);
}

/**
 * Returns the names of REQUIRED sections that are still empty (i.e. only
 * contain the placeholder italic guidance). Used as soft enforcement at finalize.
 */
export async function checkRequiredSectionsFilled(filePath: string): Promise<ReasoningSection[]> {
  const content = await readReasoning(filePath);
  const empty: ReasoningSection[] = [];
  for (const section of REQUIRED_SECTIONS) {
    if (isSectionEmpty(content, section)) empty.push(section);
  }
  return empty;
}

function isSectionEmpty(content: string, section: ReasoningSection): boolean {
  const heading = `## ${section}`;
  const idx = content.indexOf(heading);
  if (idx === -1) return true;
  const after = content.indexOf("\n## ", idx + heading.length);
  const sectionBody = content
    .slice(idx + heading.length, after === -1 ? undefined : after)
    .trim();
  // Empty if it only contains the italic guidance placeholder.
  const guidance = TEMPLATE_GUIDANCE[section].trim();
  return sectionBody === guidance || sectionBody === "";
}
