import { describe, test, expect } from "bun:test";
import { parseFrontmatter, writeFrontmatter, type PlanFrontmatter } from "../plan-frontmatter.js";

describe("plan-frontmatter", () => {
  test("parses frontmatter from plan with header", () => {
    const md = `---
title: Vienna Marathon
slug: vienna-2026
created: 2026-03-05
---

# Vienna Marathon → Race to the Stones

body content here
`;
    const { frontmatter, body } = parseFrontmatter(md);
    expect(frontmatter).toEqual({
      title: "Vienna Marathon",
      slug: "vienna-2026",
      created: "2026-03-05",
    });
    expect(body.startsWith("# Vienna Marathon")).toBe(true);
  });

  test("returns nulls when no frontmatter present", () => {
    const md = "# A plan with no frontmatter\n\nbody";
    const { frontmatter, body } = parseFrontmatter(md);
    expect(frontmatter).toBeNull();
    expect(body).toBe(md);
  });

  test("writeFrontmatter prepends a frontmatter block", () => {
    const fm: PlanFrontmatter = {
      title: "Spring Dual",
      slug: "spring-2026",
      created: "2026-03-05",
    };
    const result = writeFrontmatter(fm, "# Spring Dual\n\nbody");
    expect(result).toBe(`---
title: Spring Dual
slug: spring-2026
created: 2026-03-05
---

# Spring Dual

body`);
  });

  test("writeFrontmatter replaces existing frontmatter", () => {
    const original = `---
title: Old
slug: old
created: 2026-01-01
---

body
`;
    const fm: PlanFrontmatter = {
      title: "New",
      slug: "new",
      created: "2026-01-01",
    };
    const result = writeFrontmatter(fm, original);
    expect(result.startsWith("---\ntitle: New\nslug: new\ncreated: 2026-01-01\n---\n")).toBe(true);
    expect(result).toContain("body");
    expect(result).not.toContain("title: Old");
  });

  test("rejects values containing newlines or colons (defensive)", () => {
    expect(() => writeFrontmatter({ title: "bad: title", slug: "s", created: "2026-01-01" }, "")).toThrow();
    expect(() => writeFrontmatter({ title: "ok", slug: "s\nlines", created: "2026-01-01" }, "")).toThrow();
  });
});
