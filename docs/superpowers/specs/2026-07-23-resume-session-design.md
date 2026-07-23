# Resume Previous Session (`--resume`)

**Date:** 2026-07-23
**Status:** Approved

## Problem

Every launch starts a fresh SDK session. The plumbing half-exists: `agent.ts`
passes `resume: getCurrentSessionId()` to the Agent SDK, but the session ID
only lives in memory (set after the SDK's `init` message), so it is always
`null` at startup. `data/.session` and `data/.chat-history.jsonl` are stale
artifacts no code reads or writes. There is no `--resume` flag.

## Design

The SDK does the heavy lifting — `resume: <session-id>` reloads the full
conversation state in the subprocess. The app's job is to persist the ID,
replay the visible transcript, and wire up the flag.

1. **Session ID persistence** (`src/utils/session.ts`):
   - `persistSessionId(id)` — write `data/.session` (fire-and-forget), called
     from the `init` handler in `handleSdkMessage.ts` alongside `setSessionId`.
   - `loadPersistedSessionId()` — read + validate (UUID shape), null if absent.

2. **Chat history** (`src/utils/chat-history.ts`, new):
   - JSONL at `data/.chat-history.jsonl`, one `{role, content, ts}` per line.
   - `appendChatMessage(role, content)` — O(1) `fs.appendFile`; called from
     `addMessage` in App.tsx for user/assistant roles only (tool/debug/error
     stay out of the transcript).
   - `loadChatHistory(limit = 100)` — last N messages; corrupt lines skipped.
   - `resetChatHistory()` — truncate; called on every fresh (non-resume) start
     so the file always matches the live SDK session.

3. **Flag & startup** (`src/cli/index.tsx`, `src/cli/App.tsx`):
   - `--resume` in argv → `startCLI` passes `resume` prop to `<App>`.
   - In App init, when resuming: load persisted ID → `setSessionId()` BEFORE
     `createAgentOptions()` (that's where `resume:` is read); load history and
     seed it directly into `committed` (not via `addMessage`, so nothing is
     re-appended); print "Resumed session (N earlier messages)".
   - Resume requested but no `.session` on disk → "No previous session found —
     starting fresh" and normal startup.
   - Everything else (onboarding check, startupSync, first prompt) unchanged.

## Error handling

| Failure | Behavior |
|---|---|
| `.session` missing/garbage on `--resume` | Note + fresh session |
| Corrupt lines in history JSONL | Skipped silently, rest replays |
| SDK can't find the session (e.g. stale ID) | SDK errors surface as usual; fresh start self-heals both files |
| History append fails | Fire-and-forget; never blocks the UI |

## Testing

- Unit (bun test): history serialize/parse round-trip, corrupt-line tolerance,
  limit trimming, session-ID validation.
- Manual: run app, chat, quit, relaunch with `--resume` — transcript replays
  and the coach retains conversation memory.
