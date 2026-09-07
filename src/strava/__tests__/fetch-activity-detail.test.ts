import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { fetchActivityDetail } from "../client.js";

let tmp: string;
let originalEnv: string | undefined;
let originalFetch: typeof fetch;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "runnai-detail-"));
  await fs.mkdir(path.join(tmp, "strava"), { recursive: true });
  await fs.writeFile(path.join(tmp, "strava", "tokens.json"), JSON.stringify({
    access_token: "test-token", refresh_token: "r", expires_at: Math.floor(Date.now() / 1000) + 3600,
  }));
  originalEnv = process.env.RUNNAI_DATA_DIR;
  process.env.RUNNAI_DATA_DIR = tmp;
  originalFetch = globalThis.fetch;
});
afterEach(async () => {
  globalThis.fetch = originalFetch;
  if (originalEnv === undefined) delete process.env.RUNNAI_DATA_DIR;
  else process.env.RUNNAI_DATA_DIR = originalEnv;
  await fs.rm(tmp, { recursive: true, force: true });
});

function stubDetail(body: Record<string, unknown>) {
  globalThis.fetch = (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
}

describe("fetchActivityDetail", () => {
  test("returns the athlete's description alongside best efforts and laps", async () => {
    stubDetail({ description: "easy shakeout, calves tight", best_efforts: [], laps: [] });
    const detail = await fetchActivityDetail(90000000001);
    expect(detail.description).toBe("easy shakeout, calves tight");
    expect(detail.bestEfforts).toEqual([]);
    expect(detail.laps).toEqual([]);
  });

  test("description is null when Strava sends none", async () => {
    stubDetail({ best_efforts: [], laps: [] });
    const detail = await fetchActivityDetail(90000000002);
    expect(detail.description).toBeNull();
  });
});
