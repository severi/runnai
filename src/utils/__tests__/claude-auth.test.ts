import { describe, test, expect } from "bun:test";
import { parseAuthStatus, extractLoginUrl } from "../claude-auth.js";

describe("parseAuthStatus", () => {
  test("parses logged-in status with email", () => {
    const stdout = JSON.stringify({
      loggedIn: true,
      authMethod: "claude.ai",
      email: "runner@example.com",
      subscriptionType: "max",
    });
    expect(parseAuthStatus(stdout)).toEqual({ loggedIn: true, email: "runner@example.com" });
  });

  test("parses logged-out status", () => {
    expect(parseAuthStatus('{"loggedIn": false}')).toEqual({ loggedIn: false, email: undefined });
  });

  test("tolerates noise before the JSON object", () => {
    const stdout = 'Checking auth...\n{"loggedIn": true, "email": "a@b.c"}\n';
    expect(parseAuthStatus(stdout)).toEqual({ loggedIn: true, email: "a@b.c" });
  });

  test("returns null for garbage", () => {
    expect(parseAuthStatus("command not found")).toBeNull();
    expect(parseAuthStatus("")).toBeNull();
  });

  test("returns null when loggedIn field is missing", () => {
    expect(parseAuthStatus('{"email": "a@b.c"}')).toBeNull();
  });
});

describe("extractLoginUrl", () => {
  test("finds URL embedded in text", () => {
    const out = "Opening browser to https://claude.ai/oauth/authorize?code=abc123 ...";
    expect(extractLoginUrl(out)).toBe("https://claude.ai/oauth/authorize?code=abc123");
  });

  test("strips trailing punctuation", () => {
    expect(extractLoginUrl("Visit https://claude.ai/login.")).toBe("https://claude.ai/login");
  });

  test("returns null when no URL present", () => {
    expect(extractLoginUrl("Press Enter to continue")).toBeNull();
  });
});
