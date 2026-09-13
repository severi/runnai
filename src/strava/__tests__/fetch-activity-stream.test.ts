import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { fetchActivityStream } from "../client.js";

let tmp: string;
let originalEnv: string | undefined;
let originalFetch: typeof fetch;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "runnai-stream-"));
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

function stubStreams(body: Record<string, unknown>) {
  const urls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    urls.push(String(input));
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
  return urls;
}

describe("fetchActivityStream", () => {
  test("requests the watts stream and returns it when Strava sends one", async () => {
    const urls = stubStreams({ time: { data: [0, 1] }, watts: { data: [180, 200] } });
    const stream = await fetchActivityStream(90000000010);
    expect(new URL(urls[0]).searchParams.get("keys")!.split(",")).toContain("watts");
    expect(stream?.watts).toEqual([180, 200]);
  });

  test("watts is undefined for an activity without a power meter", async () => {
    stubStreams({ time: { data: [0, 1] }, heartrate: { data: [120, 130] } });
    const stream = await fetchActivityStream(90000000011);
    expect(stream?.watts).toBeUndefined();
  });
});
