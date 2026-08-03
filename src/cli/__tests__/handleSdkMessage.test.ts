import { describe, test, expect } from "bun:test";
import { handleSdkMessage, type MessageHandlerCallbacks, type MessageHandlerState } from "../handleSdkMessage.js";

// ─── Thinking blocks ─────────────────────────────────────────────────────────
// Opus 5 turns thinking on by default but defaults `display` to "omitted",
// which streams thinking blocks whose text is an empty string. The handler used
// to ignore thinking blocks entirely while still firing onUsage per assistant
// message, so a turn with 14 thinking-only messages redrew the live region
// every few seconds with nothing new in it — visible as flicker. With
// display: "summarized" the blocks carry text worth committing; empty ones must
// still be skipped rather than committed as blank lines.

function harness() {
  const messages: Array<{ role: string; content: string }> = [];
  const streaming: Array<string | null> = [];
  const callbacks: MessageHandlerCallbacks = {
    addMessage: (role, content) => messages.push({ role, content }),
    setStreamingText: (t) => streaming.push(t),
    toolTracker: {
      startTool: () => {},
      updateSummary: () => {},
      completeTool: () => {},
      activeTools: [],
    } as unknown as MessageHandlerCallbacks["toolTracker"],
  };
  const state: MessageHandlerState = { currentResponse: "", hadToolCall: false };
  return { messages, streaming, callbacks, state };
}

/** An `assistant` SDK message carrying the given content blocks. */
function assistantMsg(content: unknown[]): any {
  return { type: "assistant", message: { content, usage: {} } };
}

describe("handleSdkMessage — thinking blocks", () => {
  test("a summarized thinking block is committed under the 'thinking' role", () => {
    const { messages, callbacks, state } = harness();

    handleSdkMessage(
      assistantMsg([{ type: "thinking", thinking: "Checking the lap splits against grade." }]),
      callbacks,
      state,
    );

    expect(messages).toEqual([
      { role: "thinking", content: "Checking the lap splits against grade." },
    ]);
  });

  test("an empty thinking block commits nothing (the flicker case)", () => {
    const { messages, callbacks, state } = harness();

    // display: "omitted" — the block arrives, its text does not.
    handleSdkMessage(assistantMsg([{ type: "thinking", thinking: "" }]), callbacks, state);
    // Whitespace-only is equally useless.
    handleSdkMessage(assistantMsg([{ type: "thinking", thinking: "   \n " }]), callbacks, state);
    // Older CLIs may omit the field entirely.
    handleSdkMessage(assistantMsg([{ type: "thinking" }]), callbacks, state);

    expect(messages).toEqual([]);
  });

  test("pending assistant text is flushed before the thinking line, preserving order", () => {
    const { messages, callbacks, state } = harness();

    handleSdkMessage(assistantMsg([{ type: "text", text: "Looking at Saturday." }]), callbacks, state);
    expect(messages).toEqual([]); // still buffered as streaming text
    expect(state.currentResponse).toBe("Looking at Saturday.");

    handleSdkMessage(assistantMsg([{ type: "thinking", thinking: "Grade-adjusting." }]), callbacks, state);

    expect(messages).toEqual([
      { role: "assistant", content: "Looking at Saturday." },
      { role: "thinking", content: "Grade-adjusting." },
    ]);
    expect(state.currentResponse).toBe("");
  });

  test("an empty thinking block does not flush buffered text", () => {
    const { messages, callbacks, state } = harness();

    handleSdkMessage(assistantMsg([{ type: "text", text: "Half a sentence" }]), callbacks, state);
    handleSdkMessage(assistantMsg([{ type: "thinking", thinking: "" }]), callbacks, state);

    expect(messages).toEqual([]);
    expect(state.currentResponse).toBe("Half a sentence");
  });

  test("text and thinking in one message keep their block order", () => {
    const { messages, callbacks, state } = harness();

    handleSdkMessage(
      assistantMsg([
        { type: "text", text: "One moment." },
        { type: "thinking", thinking: "Pulling the streams." },
      ]),
      callbacks,
      state,
    );

    expect(messages).toEqual([
      { role: "assistant", content: "One moment." },
      { role: "thinking", content: "Pulling the streams." },
    ]);
  });
});
