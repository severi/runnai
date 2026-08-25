/**
 * Mechanical check of the Voice rules in the coach system prompt.
 *
 * The rules ("no em dashes", "no 'not X, it's Y'", short sentences, bold for
 * at most two things) hold on short replies and decay on long assessments,
 * where the model drifts back to its default register. Naming the bans in the
 * prompt was not enough on its own (verified Aug 24, 2026: a 600-word answer
 * broke four of them). This lint runs as a Stop hook and sends the reply back
 * for a rewrite with the offending lines named.
 */

export type LintRule = "em-dash" | "antithesis" | "long-sentence" | "bold-overuse";

export interface LintFinding {
  rule: LintRule;
  /** 1-indexed line in the reply. */
  line: number;
  excerpt: string;
  message: string;
}

const MAX_SENTENCE_WORDS = 40;
// The prompt says two. The lint blocks only clear overuse (a bolded opener on
// every paragraph); three or four is left to the prompt so ordinary analyses
// are not bounced for a rewrite.
const MAX_BOLD_PHRASES = 4;
const MAX_ANTITHESIS = 1;

const ANTITHESIS_PATTERNS: RegExp[] = [
  // "sounds encouraging and isn't", "looks fine and is not"
  /\band (isn't|is not|aren't|doesn't|wasn't|won't)\b/i,
  // "needs no growth. It needs your threshold to climb" — the two-sentence form
  /\b(not|never|no)\b[^.!?\n]{1,60}?[.!]\s+(It's|It is|It needs|That's|This is|What it)\b/,
  // "X, not Y." trailing contrast
  /,\s*not\s+(a|an|the|your|his|her|their)?\s?[a-z][^.!?\n]{0,40}[.!?]/i,
];

function isProseLine(line: string): boolean {
  const t = line.trim();
  if (!t) return false;
  if (t.startsWith("#")) return false;
  if (t.startsWith("|")) return false;
  return true;
}

function excerptOf(line: string): string {
  const t = line.trim();
  return t.length > 90 ? t.slice(0, 87) + "..." : t;
}

export function lintReply(text: string): LintFinding[] {
  const findings: LintFinding[] = [];
  const lines = text.split("\n");

  let inFence = false;
  let boldCount = 0;
  let boldLines: number[] = [];
  let antithesisHits: LintFinding[] = [];

  lines.forEach((raw, i) => {
    const lineNo = i + 1;
    if (/^\s*```/.test(raw)) {
      inFence = !inFence;
      return;
    }
    if (inFence) return;
    if (!isProseLine(raw)) return;

    if (raw.includes("—")) {
      findings.push({ rule: "em-dash", line: lineNo, excerpt: excerptOf(raw), message: "em dash; use a comma, a period, or 'and'" });
    }

    for (const re of ANTITHESIS_PATTERNS) {
      if (re.test(raw)) {
        antithesisHits.push({ rule: "antithesis", line: lineNo, excerpt: excerptOf(raw), message: "'not X, it's Y' contrast; say what the thing is directly" });
        break;
      }
    }

    // Bold in prose. A bold label opening a list item ("- **Volume:** ...") is
    // structure, not emphasis, and is not counted.
    const withoutLabel = raw.replace(/^\s*(?:[-*+]|\d+\.)\s+\*\*[^*\n]+?:\*\*/, "");
    const bolds = withoutLabel.match(/\*\*[^*\n]+?\*\*/g);
    if (bolds) {
      boldCount += bolds.length;
      boldLines.push(lineNo);
    }

    // Sentence length. Strip URLs and inline markdown before counting.
    const plain = raw.replace(/https?:\/\/\S+/g, "url").replace(/[*_`]/g, "");
    // A colon or semicolon starts a new clause for this purpose; the rule is
    // about how much the athlete has to hold in their head at once.
    for (const sentence of plain.split(/(?<=[.!?:;])\s+/)) {
      const words = sentence.trim().split(/\s+/).filter(Boolean);
      if (words.length > MAX_SENTENCE_WORDS) {
        findings.push({ rule: "long-sentence", line: lineNo, excerpt: excerptOf(sentence), message: `${words.length} words in one sentence; split it (max ${MAX_SENTENCE_WORDS})` });
      }
    }
  });

  if (antithesisHits.length > MAX_ANTITHESIS) findings.push(...antithesisHits);

  if (boldCount > MAX_BOLD_PHRASES) {
    findings.push({
      rule: "bold-overuse",
      line: boldLines[boldLines.length - 1] ?? 1,
      excerpt: `${boldCount} bolded phrases (lines ${boldLines.join(", ")})`,
      message: `bold marks at most ${MAX_BOLD_PHRASES} things per reply; the rest is decoration`,
    });
  }

  return findings.sort((a, b) => a.line - b.line);
}

const RULE_LABEL: Record<LintRule, string> = {
  "em-dash": "em dash",
  antithesis: "antithesis",
  "long-sentence": "long sentence",
  "bold-overuse": "bold overuse",
};

/** Reason text handed back to the model when the Stop hook blocks. */
export function formatLintReason(findings: LintFinding[]): string {
  const items = findings.map((f) => `- line ${f.line} (${RULE_LABEL[f.rule]}): ${f.message}\n    "${f.excerpt}"`);
  return [
    "Style check failed. Rewrite the whole reply plainly for the athlete, keeping every fact and number, and fix these:",
    ...items,
    "Do not mention this check or that you are rewriting. Post only the final reply.",
  ].join("\n");
}
