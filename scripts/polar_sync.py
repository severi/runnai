#!/usr/bin/env python3
"""Push new Polar Flow sessions to Garmin Connect.

Why this exists: some sessions (basketball) are recorded on a Polar device, but
the coach reads everything from Garmin Connect, which also forwards to Strava.
Polar has no Garmin export, so the manual route was: download the FIT from
flow.polar.com, upload it to Garmin Connect. This does both.

Polar side is the official AccessLink v3 API (OAuth2, your own registered
client — admin.polaraccesslink.com). Two limits worth knowing:
  - only sessions uploaded to Flow in the last 30 days are listed
  - only sessions uploaded AFTER `login` registered you are listed at all
Garmin side reuses garmin_fit.py's sign-in.

Usage:
    polar_sync.py login            # one-time: approve in the browser
    polar_sync.py push [--dry-run] # download new Polar FITs, upload to Garmin

Credentials: POLAR_CLIENT_ID / POLAR_CLIENT_SECRET from the environment or the
project's .env. Diagnostics go to stderr; `push` prints one JSON document.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
# Outside data/ for the same reason as .garmin-tokens: data/ is auto-backed-up
# to its own git repo.
TOKEN_FILE = PROJECT_ROOT / ".polar-tokens" / "token.json"
POLAR_DIR = Path(os.getenv("RUNNAI_DATA_DIR") or PROJECT_ROOT / "data") / "polar"
# Polar exercise ids already handled, so a session is uploaded once.
PUSHED_FILE = POLAR_DIR / "pushed.json"

AUTH_URL = "https://flow.polar.com/oauth2/authorization"
TOKEN_URL = "https://polarremote.com/v2/oauth2/token"
API = "https://www.polaraccesslink.com/v3"
# Must match the redirect URL registered on the client exactly.
REDIRECT_URI = "http://localhost:5000/oauth2_callback"
LOGIN_COMMAND = ".venv-garmin/bin/python scripts/polar_sync.py login"


def _load_dotenv() -> None:
    """The app loads .env itself; this covers running the script by hand."""
    env = PROJECT_ROOT / ".env"
    if not env.exists():
        return
    for line in env.read_text().splitlines():
        key, sep, value = line.strip().partition("=")
        if sep and key and not key.startswith("#"):
            os.environ.setdefault(key.strip(), value.strip().strip("\"'"))


def _credentials() -> tuple[str, str]:
    _load_dotenv()
    cid, secret = os.getenv("POLAR_CLIENT_ID"), os.getenv("POLAR_CLIENT_SECRET")
    if not cid or not secret:
        sys.exit("Polar not configured: set POLAR_CLIENT_ID and POLAR_CLIENT_SECRET in .env.")
    return cid, secret


def _request(method: str, url: str, *, headers: dict, data: bytes | None = None) -> tuple[int, bytes]:
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read()


def _token() -> str:
    if not TOKEN_FILE.exists():
        sys.exit(f"Polar sign-in missing. Run this once in your terminal:\n  {LOGIN_COMMAND}")
    return json.loads(TOKEN_FILE.read_text())["access_token"]


def _api_get(path: str, token: str, accept: str = "application/json") -> bytes:
    status, body = _request("GET", f"{API}{path}", headers={
        "Authorization": f"Bearer {token}", "Accept": accept,
    })
    if status == 401:
        sys.exit(f"Polar sign-in expired (401). Run again:\n  {LOGIN_COMMAND}")
    if status >= 300:
        raise RuntimeError(f"Polar GET {path} -> {status}: {body[:200]!r}")
    return body


def cmd_login(_args: argparse.Namespace) -> None:
    cid, secret = _credentials()
    query = urllib.parse.urlencode({
        "response_type": "code", "client_id": cid, "redirect_uri": REDIRECT_URI,
        "scope": "accesslink.read_all",
    })
    received: dict[str, str] = {}

    class Callback(BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802 - http.server API
            params = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            received.update({k: v[0] for k, v in params.items()})
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.end_headers()
            self.wfile.write(b"Polar connected. You can close this tab.")

        def log_message(self, *_):
            pass

    server = HTTPServer(("localhost", 5000), Callback)
    url = f"{AUTH_URL}?{query}"
    print(f"Opening Polar Flow to approve access:\n  {url}", file=sys.stderr)
    webbrowser.open(url)
    while "code" not in received and "error" not in received:
        server.handle_request()
    server.server_close()
    if "error" in received:
        sys.exit(f"Polar authorization refused: {received['error']}")

    basic = base64.b64encode(f"{cid}:{secret}".encode()).decode()
    status, body = _request("POST", TOKEN_URL, headers={
        "Authorization": f"Basic {basic}",
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "application/json",
    }, data=urllib.parse.urlencode({
        "grant_type": "authorization_code", "code": received["code"], "redirect_uri": REDIRECT_URI,
    }).encode())
    if status >= 300:
        sys.exit(f"Polar token exchange failed ({status}): {body[:300]!r}")
    token = json.loads(body)

    # Data is only visible to a client after the user is registered with it.
    # 409 means already registered — fine on a re-login.
    status, body = _request("POST", f"{API}/users", headers={
        "Authorization": f"Bearer {token['access_token']}",
        "Content-Type": "application/json", "Accept": "application/json",
    }, data=json.dumps({"member-id": f"runnai-{token.get('x_user_id', 'user')}"}).encode())
    if status >= 300 and status != 409:
        sys.exit(f"Polar user registration failed ({status}): {body[:300]!r}")

    TOKEN_FILE.parent.mkdir(parents=True, exist_ok=True)
    TOKEN_FILE.write_text(json.dumps(token))
    TOKEN_FILE.chmod(0o600)
    print("Polar connected. Sessions uploaded to Flow from now on will be pushed to Garmin.")


def _load_pushed() -> dict:
    return json.loads(PUSHED_FILE.read_text()) if PUSHED_FILE.exists() else {}


def cmd_push(args: argparse.Namespace) -> None:
    _credentials()
    token = _token()
    exercises = json.loads(_api_get("/exercises", token) or b"[]")
    pushed = _load_pushed()
    new = [e for e in exercises if e.get("id") and e["id"] not in pushed]

    result = {"listed": len(exercises), "pushed": [], "errors": []}
    if not new or args.dry_run:
        result["pending"] = [{"id": e["id"], "sport": e.get("sport"), "start_time": e.get("start_time")} for e in new]
        json.dump(result, sys.stdout)
        return

    # Garmin sign-in only when there is something to upload.
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import garmin_fit

    garmin = garmin_fit.connect()
    POLAR_DIR.mkdir(parents=True, exist_ok=True)
    for e in new:
        info = {"id": e["id"], "sport": e.get("detailed_sport_info") or e.get("sport"),
                "start_time": e.get("start_time")}
        try:
            fit = POLAR_DIR / f"{e['id']}.fit"
            fit.write_bytes(_api_get(f"/exercises/{e['id']}/fit", token, accept="*/*"))
            try:
                garmin.upload_activity(str(fit))
                info["garmin"] = "uploaded"
            except Exception as exc:  # noqa: BLE001 - library raises various types
                # Garmin answers 409 for a file it already has (e.g. uploaded by hand).
                if "409" not in str(exc) and "duplicate" not in str(exc).lower():
                    raise
                info["garmin"] = "already there"
            pushed[e["id"]] = info
            result["pushed"].append(info)
        except Exception as exc:  # noqa: BLE001 - one bad session must not block the rest
            result["errors"].append({**info, "error": str(exc)[:300]})
            print(f"Polar push failed for {e['id']}: {exc}", file=sys.stderr)

    PUSHED_FILE.write_text(json.dumps(pushed, indent=2))
    json.dump(result, sys.stdout)


def main() -> None:
    parser = argparse.ArgumentParser(description="Push new Polar Flow sessions to Garmin Connect.")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("login", help="One-time browser approval.").set_defaults(func=cmd_login)
    p_push = sub.add_parser("push", help="Upload new Polar sessions to Garmin; JSON result.")
    p_push.add_argument("--dry-run", action="store_true", help="List what would be pushed.")
    p_push.set_defaults(func=cmd_push)
    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
