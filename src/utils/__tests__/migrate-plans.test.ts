import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { migratePlans } from "../migrate-plans.js";
import { getPlansRoot, getPlanFile, getVersionPlanFile } from "../plan-paths.js";

let tmp: string;
let originalEnv: string | undefined;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "runnai-mig-"));
  originalEnv = process.env.RUNNAI_DATA_DIR;
  process.env.RUNNAI_DATA_DIR = tmp;
});
afterEach(async () => {
  if (originalEnv === undefined) delete process.env.RUNNAI_DATA_DIR;
  else process.env.RUNNAI_DATA_DIR = originalEnv;
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("migrate-plans", () => {
  test("converts vienna-marathon-2026.md to dir layout", async () => {
    const oldPath = path.join(getPlansRoot(), "vienna-marathon-2026.md");
    await fs.mkdir(getPlansRoot(), { recursive: true });
    await fs.writeFile(oldPath, "# Vienna Marathon → Race to the Stones 100km\n\nbody...");

    const result = await migratePlans();
    expect(result.migrated).toEqual(["vienna-marathon-2026"]);

    const slug = "vienna-marathon-2026";
    const planFile = await fs.readFile(getPlanFile(slug), "utf-8");
    expect(planFile).toContain("---\ntitle: ");
    expect(planFile).toContain("slug: vienna-marathon-2026");
    expect(planFile).toContain("# Vienna Marathon");

    expect(await fs.readFile(getVersionPlanFile(slug, 1), "utf-8")).toContain("# Vienna Marathon");

    const reasoning = await fs.readFile(
      path.join(getPlansRoot(), slug, "versions", "v1", "reasoning.md"),
      "utf-8",
    );
    expect(reasoning).toContain("Migrated from pre-versioning era");

    const cl = await fs.readFile(path.join(getPlansRoot(), slug, "CHANGELOG.md"), "utf-8");
    expect(cl).toContain("v1: Migrated to versioned layout");

    expect(await fs.access(oldPath).catch(() => "missing")).toBe("missing");

    const refsIdx = await fs.readFile(
      path.join(getPlansRoot(), slug, "references", "INDEX.md"),
      "utf-8",
    );
    expect(refsIdx).toContain("# References");
    const resIdx = await fs.readFile(
      path.join(getPlansRoot(), slug, "research", "INDEX.md"),
      "utf-8",
    );
    expect(resIdx).toContain("# Research used in this plan");
  });

  test("is idempotent: second run does nothing", async () => {
    const oldPath = path.join(getPlansRoot(), "x.md");
    await fs.mkdir(getPlansRoot(), { recursive: true });
    await fs.writeFile(oldPath, "# X");

    await migratePlans();
    const result2 = await migratePlans();
    expect(result2.migrated).toEqual([]);
    expect(result2.skipped).toEqual(["x"]);
  });

  test("respects existing title from first heading line", async () => {
    const oldPath = path.join(getPlansRoot(), "spring-dual.md");
    await fs.mkdir(getPlansRoot(), { recursive: true });
    await fs.writeFile(oldPath, "# Custom Title Goes Here\n\nbody");

    await migratePlans();
    const planFile = await fs.readFile(getPlanFile("spring-dual"), "utf-8");
    expect(planFile).toContain("title: Custom Title Goes Here");
  });
});
