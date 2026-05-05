export interface PlanFrontmatter {
  title: string;
  slug: string;
  created: string; // YYYY-MM-DD
}

const FIELD_ORDER: (keyof PlanFrontmatter)[] = ["title", "slug", "created"];

export function parseFrontmatter(markdown: string): {
  frontmatter: PlanFrontmatter | null;
  body: string;
} {
  if (!markdown.startsWith("---\n")) {
    return { frontmatter: null, body: markdown };
  }
  const end = markdown.indexOf("\n---\n", 4);
  if (end === -1) return { frontmatter: null, body: markdown };

  const block = markdown.slice(4, end);
  const body = markdown.slice(end + 5).replace(/^\n/, "");

  const fm: Partial<PlanFrontmatter> = {};
  for (const line of block.split("\n")) {
    const m = line.match(/^([a-z]+):\s*(.+)$/);
    if (!m) continue;
    const [, key, value] = m;
    if (key === "title" || key === "slug" || key === "created") {
      fm[key] = value.trim();
    }
  }
  if (!fm.title || !fm.slug || !fm.created) return { frontmatter: null, body: markdown };
  return { frontmatter: fm as PlanFrontmatter, body };
}

export function writeFrontmatter(fm: PlanFrontmatter, body: string): string {
  for (const key of FIELD_ORDER) {
    const v = fm[key];
    if (typeof v !== "string" || v.length === 0) {
      throw new Error(`frontmatter.${key} must be a non-empty string`);
    }
    if (v.includes("\n") || v.includes(":")) {
      throw new Error(`frontmatter.${key} must not contain ':' or newlines: ${JSON.stringify(v)}`);
    }
  }

  // If body already starts with frontmatter, strip it before prepending.
  const existing = parseFrontmatter(body);
  const cleanBody = existing.frontmatter ? existing.body : body;

  const lines = FIELD_ORDER.map((k) => `${k}: ${fm[k]}`).join("\n");
  return `---\n${lines}\n---\n\n${cleanBody}`;
}
