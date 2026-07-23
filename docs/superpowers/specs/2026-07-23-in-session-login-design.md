# In-Session Login (`/login`)

**Date:** 2026-07-23
**Status:** Approved

## Problem

When the user isn't authenticated, the coach subprocess replies "Not logged in ·
Please run /login" — but the CLI has no `/login` command. Startup only checks
that the `claude` binary exists (`which claude`), not that it's authenticated,
so the app prints "Auth: Claude account" even when logged out. The user must
quit and authenticate externally.

## Approach (chosen: spawn + poll in-app)

The `claude` binary provides `claude auth login` (browser OAuth) and
`claude auth status` (JSON: `loggedIn`, `email`, …). The CLI drives login
itself, with no Ink suspend / terminal handoff:

1. **`/login` command** (local command in `src/cli/commands.ts`):
   - If `claude auth status` reports `loggedIn: true` → print
     "Already logged in as <email>" and stop.
   - Otherwise spawn `claude auth login` with piped stdio. The child opens the
     browser itself; scan its output for the login URL and print it as a system
     message so it's clickable if the browser doesn't launch.
   - Poll `claude auth status` every 2s (up to 3 min). On success: kill the
     child, print "Logged in as <email>". On child exit with failure, or
     timeout: print fallback instructions to run `claude auth login` in a
     separate terminal.
   - Nothing renders on a timer — polling prints only on state change
     (consistent with the event-driven live-region rule).
   - `claude` binary missing (spawn ENOENT) → print install instructions.

2. **Accurate startup detection** (`src/cli/index.tsx`): when no
   `ANTHROPIC_API_KEY` and `claude` is installed, run `claude auth status`.
   Logged in → `Auth: Claude account (<email>)`. Logged out → still start the
   app, print "Not logged in — type /login in the session to authenticate."

3. **Credential pickup:** the persistent SDK subprocess reads OAuth credentials
   from the keychain per request (token refresh), so the next message after
   login succeeds without a subprocess restart. If real-world use proves the
   subprocess caches logged-out state, the follow-up is a query restart — not
   built until proven necessary (YAGNI).

## Components

- `src/utils/claude-auth.ts` — new helper module:
  - `parseAuthStatus(stdout)` — tolerant JSON extraction → `{loggedIn, email?} | null`
  - `extractLoginUrl(text)` — first `https://…` URL in child output, or null
  - `getAuthStatus()` — runs `claude auth status`, parses stdout even on
    non-zero exit, 10s timeout, never throws
- `src/cli/commands.ts` — `/login` local command using the helpers
- `src/cli/index.tsx` — startup auth line uses `getAuthStatus()`

## Error handling

| Failure | Behavior |
|---|---|
| `claude` not installed | `/login` prints install instructions |
| Status JSON unparseable | Treated as logged out |
| Child exits non-zero | Fallback message (external login instructions) |
| No login within 3 min | Kill child, same fallback message |

## Testing

- Unit tests (bun test): `parseAuthStatus` (valid JSON, logged-out JSON, noise
  around JSON, garbage), `extractLoginUrl` (URL mid-text, trailing
  punctuation, no URL).
- Manual: live `/login` flow needs a logged-out machine; can't be exercised by
  the assistant without destroying the user's active session auth.
