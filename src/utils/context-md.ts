/**
 * Section-level editing for CONTEXT.md (the hot cache).
 *
 * Why this exists: update_context originally had full-file-replace semantics
 * only, while every prompt teaches section-thinking ("refresh the Key Metrics
 * section", "update the Current Training Plan section"). A model call with
 * {section, content} had its unknown `section` key silently stripped by the
 * schema layer, and a 594-char section body overwrote the entire hot cache
 * (recovered from data-git ffc59e8). These helpers give the tool real section
 * semantics plus a guard against partial content wiping the whole file.
 */

const HEADING = /^##\s+/;

function normalizeHeading(s: string): string {
  return s.replace(/^#+\s*/, "").trim().toLowerCase();
}

function headingIndexes(lines: string[]): number[] {
  const idxs: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (HEADING.test(lines[i])) idxs.push(i);
  }
  return idxs;
}

export type SectionReplaceResult =
  | { ok: true; result: string }
  | { ok: false; error: string };

/** Replace one `## Section` block, preserving everything else in the file. */
export function replaceContextSection(
  existing: string,
  section: string,
  content: string,
): SectionReplaceResult {
  const lines = existing.split("\n");
  const idxs = headingIndexes(lines);
  const target = normalizeHeading(section);
  const start = idxs.find((i) => normalizeHeading(lines[i]) === target);

  if (start === undefined) {
    const available = idxs.map((i) => lines[i].replace(HEADING, "")).join(", ");
    return {
      ok: false,
      error: `Section "${section}" not found in CONTEXT.md. Available sections: ${available || "(none)"}`,
    };
  }

  const end = idxs.find((i) => i > start) ?? lines.length; // exclusive

  const body = content.trim();
  // Keep the original heading unless the new content already leads with it.
  const firstLine = body.split("\n")[0] ?? "";
  const block =
    HEADING.test(firstLine) && normalizeHeading(firstLine) === target
      ? body
      : `${lines[start]}\n${body}`;

  const before = lines.slice(0, start).join("\n").replace(/\n+$/, "");
  const after = lines.slice(end).join("\n").replace(/^\n+/, "");

  const result =
    (before ? `${before}\n\n` : "") + block + (after.trim() ? `\n\n${after}` : "\n");
  return { ok: true, result };
}

/**
 * Heuristic guard for full-file replacement: content that carries at most half
 * of the existing `## ` sections is almost certainly a single section that
 * should have been passed with `section` — writing it would erase the rest.
 */
export function looksLikePartialContext(existing: string, candidate: string): boolean {
  const count = (s: string) => s.split("\n").filter((l) => HEADING.test(l)).length;
  const existingCount = count(existing);
  return existingCount >= 4 && count(candidate) <= existingCount / 2;
}

export function countContextSections(s: string): number {
  return s.split("\n").filter((l) => HEADING.test(l)).length;
}
