import * as fs from "fs/promises";
import * as path from "path";
import { createHash } from "crypto";
import { getDataDir } from "./paths.js";
import { toDateString } from "./format.js";

/**
 * Every file the athlete hands to the coach (lab reports, test PDFs, photos of
 * results) is copied into data/documents/ so the source survives after the
 * original is moved or deleted from Downloads. Memory files hold the typed-up
 * extraction; this keeps the primary source next to it.
 */

export function getDocumentsDir(): string {
  return path.join(getDataDir(), "documents");
}

export function getDocumentsIndex(): string {
  return path.join(getDocumentsDir(), "INDEX.md");
}

async function sha256(file: string): Promise<string> {
  return createHash("sha256").update(await fs.readFile(file)).digest("hex");
}

async function exists(p: string): Promise<boolean> {
  return fs.access(p).then(() => true, () => false);
}

/**
 * Copy `sourcePath` into data/documents/ and record it in INDEX.md.
 * Returns the archived path (relative to the data dir).
 * - Files already inside the data dir are left where they are.
 * - Identical content already archived is reused, not duplicated.
 * - A different file with the same name gets a numeric suffix.
 */
export async function archiveDocument(sourcePath: string): Promise<string> {
  const dataDir = path.resolve(getDataDir());
  const src = path.resolve(sourcePath);
  if (src.startsWith(dataDir + path.sep)) return path.relative(dataDir, src);

  const dir = getDocumentsDir();
  await fs.mkdir(dir, { recursive: true });
  const hash = await sha256(src);

  const ext = path.extname(src);
  const stem = path.basename(src, ext);
  for (let i = 0; ; i++) {
    const name = i === 0 ? `${stem}${ext}` : `${stem}-${i + 1}${ext}`;
    const dest = path.join(dir, name);
    if (await exists(dest)) {
      if ((await sha256(dest)) === hash) return path.relative(dataDir, dest);
      continue;
    }
    await fs.copyFile(src, dest);
    await fs.appendFile(
      getDocumentsIndex(),
      `- ${name} — added ${toDateString()}, original: ${src}, sha256: ${hash.slice(0, 12)}\n`,
    );
    return path.relative(dataDir, dest);
  }
}
