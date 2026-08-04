#!/usr/bin/env python3
"""Download original Garmin FIT files.

Why this exists: Strava's public API exposes nothing about a strength session
beyond duration, calories and heart rate — no exercises, sets, reps, weights or
rest intervals. Its app shows them because it parses the uploaded FIT file
internally, but that data is not in the v3 API and never has been (checked
against the reference docs, Strava's developer forum, and by probing /sets,
/exercises, /strength — all 404). The original Garmin FIT *does* carry all of
it, so this fetches the file at source.

Auth is the unofficial Garmin Connect route: your own credentials, your own
data, via cyberjunky/python-garminconnect (PyPI name: `garminconnect`). There is
no official alternative — Garmin's developer programme requires a legal entity
and is closed to new applicants.

Every command signs in on demand, so there is no setup step to remember: run
`fetch` and it prompts for credentials + MFA the first time, then caches tokens
and never asks again. It only prompts when attached to a terminal — run
non-interactively without tokens and it exits with instructions rather than
hanging on an invisible prompt.

Usage:
    garmin_fit.py fetch --at <ISO8601>       # find by start time, then download
    garmin_fit.py fetch <garmin_activity_id> # download one FIT
    garmin_fit.py list [--days 14]           # recent activities + Garmin ids
    garmin_fit.py login                      # optional: sign in ahead of time

`--at` is the useful one: our database keys on Strava ids, which share no field
with Garmin ids, but both sides record the same start instant. Pass the Strava
activity's start_date and this resolves the Garmin activity for you.
"""

from __future__ import annotations

import argparse
import io
import os
import sys
import zipfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

try:
    from garminconnect import Garmin
except ImportError:
    sys.exit(
        "garminconnect is not installed.\n"
        "Run:  .venv-garmin/bin/pip install -r scripts/requirements-garmin.txt\n"
        "(or create the venv first: python3 -m venv .venv-garmin)"
    )

PROJECT_ROOT = Path(__file__).resolve().parent.parent
# Tokens live outside data/ deliberately: data/ is its own git repo with a
# session-end auto-backup, so credentials placed there would be committed.
TOKEN_DIR = PROJECT_ROOT / ".garmin-tokens"
FIT_DIR = PROJECT_ROOT / "data" / "fit"

# Strava marks these types for gym work; the Garmin equivalents differ in
# spelling, so match loosely when filtering `list` output.
STRENGTH_HINTS = ("strength", "weight", "training")


def connect() -> Garmin:
    """Return a logged-in client, logging in on demand if there's a terminal.

    Any command authenticates itself, so `login` is never a required first step —
    run `fetch` and it prompts if it has to. The gate is whether stdin is a TTY,
    not which subcommand was used: the coach invokes this non-interactively, and a
    bare input() prompt with no terminal attached would hang the agent instead of
    failing. Without a TTY we exit with instructions for the athlete to run.
    """
    TOKEN_DIR.mkdir(parents=True, exist_ok=True)
    interactive = sys.stdin.isatty()

    # Cached tokens first — no credentials needed, no MFA prompt.
    if any(TOKEN_DIR.iterdir()):
        try:
            api = Garmin()
            api.login(str(TOKEN_DIR))
            return api
        except Exception as exc:  # noqa: BLE001 - any failure means re-auth
            if not interactive:
                sys.exit(
                    f"Garmin tokens have expired or been rejected ({exc}).\n"
                    "They need a fresh interactive login — run this in your terminal:\n"
                    "  .venv-garmin/bin/python scripts/garmin_fit.py login"
                )
            print(f"Cached tokens rejected ({exc}); logging in again.", file=sys.stderr)

    if not interactive:
        sys.exit(
            "Not signed in to Garmin, and there is no terminal to prompt on.\n"
            "Run this once in your terminal (it will ask for password + MFA):\n"
            "  .venv-garmin/bin/python scripts/garmin_fit.py login\n"
            "Afterwards every command works unattended."
        )

    try:
        email = os.getenv("GARMIN_EMAIL") or input("Garmin email: ").strip()
        password = os.getenv("GARMIN_PASSWORD")
        if not password:
            import getpass

            password = getpass.getpass("Garmin password: ")

        api = Garmin(email=email, password=password, return_on_mfa=True)
        needs_mfa, client_state = api.login(str(TOKEN_DIR))
        if needs_mfa == "needs_mfa":
            code = input("MFA code: ").strip()
            api.resume_login(client_state, code)
            # resume_login does NOT persist tokens (verified: its source has no
            # dump call), so without this the MFA prompt returns every run.
            # The attribute is `client` — Garmin has no `.garth`; this library
            # dropped garth when it moved to curl_cffi.
            api.client.dump(str(TOKEN_DIR))
    except (EOFError, KeyboardInterrupt):
        # Ctrl-C / Ctrl-D at a prompt is a normal way to back out — say so
        # instead of dumping a traceback.
        sys.exit("\nCancelled; not signed in.")
    return api


def cmd_login(_args: argparse.Namespace) -> None:
    connect()
    # Verify tokens actually landed rather than trusting that login returned.
    # A crash between resume_login and the token dump leaves you "logged in"
    # for the life of the process and signed out for every later run — with the
    # MFA code already spent, so the next attempt needs a fresh one.
    if not any(TOKEN_DIR.iterdir()):
        sys.exit(
            "Login appeared to succeed but no tokens were written to "
            f"{TOKEN_DIR.relative_to(PROJECT_ROOT)}/.\n"
            "Nothing is cached, so this would prompt again next run. Please retry; "
            "if it keeps happening the token-persistence call needs looking at."
        )
    print(f"Logged in. Tokens cached in {TOKEN_DIR.relative_to(PROJECT_ROOT)}/")
    print("Future runs reuse them — no password or MFA needed.")


def _fmt(activity: dict) -> str:
    return (
        f"{activity.get('activityId')}  "
        f"{(activity.get('startTimeLocal') or '')[:16]}  "
        f"{(activity.get('activityType', {}) or {}).get('typeKey', '?'):<18}"
        f"{activity.get('activityName', '')}"
    )


def cmd_list(args: argparse.Namespace) -> None:
    api = connect()
    end = datetime.now(timezone.utc).date()
    start = end - timedelta(days=args.days)
    activities = api.get_activities_by_date(start.isoformat(), end.isoformat())
    if args.strength:
        activities = [
            a
            for a in activities
            if any(
                h in ((a.get("activityType", {}) or {}).get("typeKey", "") or "").lower()
                for h in STRENGTH_HINTS
            )
        ]
    if not activities:
        print(f"No activities in the last {args.days} days.")
        return
    print(f"{'GARMIN ID':<14} {'START (local)':<17} {'TYPE':<18} NAME")
    for a in activities:
        print(_fmt(a))


def _resolve_by_time(api: Garmin, iso: str) -> dict:
    """Find the Garmin activity whose start matches `iso`.

    Both platforms record the same instant, so this is an exact join rather than
    a heuristic — but timezone handling differs, so compare as UTC and allow a
    small window. Refuses to guess when more than one activity matches.
    """
    target = datetime.fromisoformat(iso.replace("Z", "+00:00"))
    if target.tzinfo is None:
        target = target.replace(tzinfo=timezone.utc)
    day = target.astimezone(timezone.utc).date()
    candidates = api.get_activities_by_date(
        (day - timedelta(days=1)).isoformat(), (day + timedelta(days=1)).isoformat()
    )

    matches = []
    for a in candidates:
        raw = a.get("startTimeGMT")
        if not raw:
            continue
        started = datetime.fromisoformat(raw.replace("Z", "")).replace(tzinfo=timezone.utc)
        if abs((started - target).total_seconds()) <= 120:
            matches.append(a)

    if not matches:
        sys.exit(
            f"No Garmin activity starting within 2 minutes of {iso}.\n"
            f"Checked {len(candidates)} activities around {day}. "
            "Try `list` to see what is there."
        )
    if len(matches) > 1:
        listing = "\n".join("  " + _fmt(m) for m in matches)
        sys.exit(f"Ambiguous — {len(matches)} activities match {iso}:\n{listing}")
    return matches[0]


def cmd_fetch(args: argparse.Namespace) -> None:
    api = connect()

    if args.at:
        activity = _resolve_by_time(api, args.at)
        activity_id = activity["activityId"]
        print(f"Resolved {args.at} -> {_fmt(activity)}")
    else:
        activity_id = args.activity_id

    blob = api.download_activity(
        str(activity_id), dl_fmt=Garmin.ActivityDownloadFormat.ORIGINAL
    )
    FIT_DIR.mkdir(parents=True, exist_ok=True)

    # ORIGINAL returns a zip archive, even for a single activity.
    written = []
    if blob[:2] == b"PK":
        with zipfile.ZipFile(io.BytesIO(blob)) as archive:
            for name in archive.namelist():
                if not name.lower().endswith(".fit"):
                    continue
                out = FIT_DIR / Path(name).name
                out.write_bytes(archive.read(name))
                written.append(out)
    else:
        out = FIT_DIR / f"{activity_id}_ACTIVITY.fit"
        out.write_bytes(blob)
        written.append(out)

    if not written:
        sys.exit(f"Download for {activity_id} contained no .fit file.")
    for out in written:
        print(f"Wrote {out.relative_to(PROJECT_ROOT)} ({out.stat().st_size:,} bytes)")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Download original Garmin FIT files (strength set data lives here, not in Strava).",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("login", help="Sign in explicitly (optional — fetch/list prompt on demand).").set_defaults(
        func=cmd_login
    )

    p_list = sub.add_parser("list", help="List recent activities with their Garmin ids.")
    p_list.add_argument("--days", type=int, default=14, help="Look-back window (default 14).")
    p_list.add_argument(
        "--strength", action="store_true", help="Only strength-type activities."
    )
    p_list.set_defaults(func=cmd_list)

    p_fetch = sub.add_parser("fetch", help="Download the original FIT into data/fit/.")
    p_fetch.add_argument("activity_id", nargs="?", help="Garmin activity id.")
    p_fetch.add_argument(
        "--at",
        help="Resolve by start time instead (ISO8601, e.g. 2026-08-03T18:07:54Z). "
        "Use the Strava activity's start_date.",
    )
    p_fetch.set_defaults(func=cmd_fetch)

    args = parser.parse_args()
    if args.command == "fetch" and not args.activity_id and not args.at:
        parser.error("fetch needs either an activity id or --at <ISO8601>")
    args.func(args)


if __name__ == "__main__":
    main()
