import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { archiveDocument, getDocumentsIndex } from "../document-archive.js";

let tmp: string;
let dataDir: string;
let originalEnv: string | undefined;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "runnai-docs-"));
  dataDir = path.join(tmp, "data");
  await fs.mkdir(dataDir);
  originalEnv = process.env.RUNNAI_DATA_DIR;
  process.env.RUNNAI_DATA_DIR = dataDir;
});
afterEach(async () => {
  if (originalEnv === undefined) delete process.env.RUNNAI_DATA_DIR;
  else process.env.RUNNAI_DATA_DIR = originalEnv;
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("archiveDocument", () => {
  test("copies an outside file into documents/ and indexes its origin", async () => {
    const src = path.join(tmp, "Alex_20260102.pdf");
    await fs.writeFile(src, "%PDF-lactate");

    const rel = await archiveDocument(src);

    expect(rel).toBe(path.join("documents", "Alex_20260102.pdf"));
    expect(await fs.readFile(path.join(dataDir, rel), "utf-8")).toBe("%PDF-lactate");
    const index = await fs.readFile(getDocumentsIndex(), "utf-8");
    expect(index).toContain("Alex_20260102.pdf");
    expect(index).toContain(src);
  });

  test("re-attaching the same file does not duplicate it", async () => {
    const src = path.join(tmp, "report.pdf");
    await fs.writeFile(src, "%PDF-a");

    expect(await archiveDocument(src)).toBe(await archiveDocument(src));
    const index = await fs.readFile(getDocumentsIndex(), "utf-8");
    expect(index.trim().split("\n")).toHaveLength(1);
  });

  test("a different file with the same name gets a suffix instead of overwriting", async () => {
    const a = path.join(tmp, "a", "report.pdf");
    const b = path.join(tmp, "b", "report.pdf");
    await fs.mkdir(path.dirname(a));
    await fs.mkdir(path.dirname(b));
    await fs.writeFile(a, "%PDF-first");
    await fs.writeFile(b, "%PDF-second");

    await archiveDocument(a);
    const rel = await archiveDocument(b);

    expect(rel).toBe(path.join("documents", "report-2.pdf"));
    expect(await fs.readFile(path.join(dataDir, "documents", "report.pdf"), "utf-8")).toBe("%PDF-first");
  });

  test("files already inside the data dir are left in place", async () => {
    const inside = path.join(dataDir, "plans", "x.pdf");
    await fs.mkdir(path.dirname(inside), { recursive: true });
    await fs.writeFile(inside, "%PDF");

    expect(await archiveDocument(inside)).toBe(path.join("plans", "x.pdf"));
    expect(await fs.access(getDocumentsIndex()).then(() => true, () => false)).toBe(false);
  });
});
