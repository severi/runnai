import { describe, test, expect } from "bun:test";
import { serializeChatLine, parseChatHistory } from "../chat-history.js";
import { isValidSessionId } from "../session.js";

describe("serializeChatLine / parseChatHistory", () => {
  test("round-trips messages", () => {
    const text =
      serializeChatLine("user", "how was my run?") +
      serializeChatLine("assistant", "Solid aerobic effort.\n\n| km | pace |\n|---|---|");
    const messages = parseChatHistory(text);
    expect(messages).toEqual([
      { role: "user", content: "how was my run?" },
      { role: "assistant", content: "Solid aerobic effort.\n\n| km | pace |\n|---|---|" },
    ]);
  });

  test("skips corrupt lines", () => {
    const text =
      serializeChatLine("user", "hello") +
      "not json\n" +
      '{"role": "assistant"}\n' + // missing content
      serializeChatLine("assistant", "hi");
    const messages = parseChatHistory(text);
    expect(messages).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ]);
  });

  test("keeps only the last `limit` messages", () => {
    let text = "";
    for (let i = 0; i < 10; i++) text += serializeChatLine("user", `msg ${i}`);
    const messages = parseChatHistory(text, 3);
    expect(messages.map((m) => m.content)).toEqual(["msg 7", "msg 8", "msg 9"]);
  });

  test("skips unknown roles", () => {
    const text = '{"role": "wizard", "content": "abracadabra"}\n' + serializeChatLine("user", "hi");
    expect(parseChatHistory(text)).toEqual([{ role: "user", content: "hi" }]);
  });

  test("empty input yields empty history", () => {
    expect(parseChatHistory("")).toEqual([]);
  });
});

describe("isValidSessionId", () => {
  test("accepts a UUID", () => {
    expect(isValidSessionId("95f93e95-6f38-4d93-be45-1c1a1d035ecb")).toBe(true);
  });

  test("rejects garbage and empty strings", () => {
    expect(isValidSessionId("")).toBe(false);
    expect(isValidSessionId("not-a-uuid")).toBe(false);
    expect(isValidSessionId("95f93e95\n")).toBe(false);
  });
});
