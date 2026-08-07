"""Prove the realtime-replacement round trip through the REAL endpoint.

The table round trip was already verified directly. This checks the part that
actually ships: an authenticated client polls /api/realtime/nudge, a server-side
bump changes the token, and an unauthenticated caller gets nothing.

That last one is the point. The scope is derived from the session, so a signed-in
user must not be able to read another user's token — the Supabase broadcast had
that property by construction and it would be easy to lose while swapping
transports.

Prereq: the app running with all three Turso flags (see verify_turso_auth.py).
    python scripts/verify_nudge_poll.py
"""
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path

BASE = "http://localhost:3210"
EMAIL = "zznudgeprobe@example.invalid"
PW = "ProbePassword!2026"

sys.path.insert(0, str(Path(r"C:\Users\User\Business-Empire-Agent\scripts").resolve()))
from lib.tls_trust import ensure_os_trust  # noqa: E402

ensure_os_trust()
import libsql  # noqa: E402

from lib.db_turso import resolve_project_target  # noqa: E402

url, tok, _ = resolve_project_target("bravo")
db = libsql.connect(database=url, auth_token=tok)

passed, failed = [], []


def check(name, ok, detail=""):
    (passed if ok else failed).append(name)
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f"  — {detail}" if detail else ""))


def call(path, method="GET", body=None, cookie=None):
    req = urllib.request.Request(BASE + path, method=method)
    if body is not None:
        req.add_header("Content-Type", "application/json")
    if cookie:
        req.add_header("Cookie", cookie)
    try:
        with urllib.request.urlopen(
                req, data=json.dumps(body).encode() if body is not None else None,
                timeout=45) as r:
            return r.status, r.read(2000).decode("utf-8", "replace"), r.headers
    except urllib.error.HTTPError as e:
        return e.code, e.read(2000).decode("utf-8", "replace"), e.headers


def cleanup():
    for sql, args in (
            ('DELETE FROM "_supabase_auth_users" WHERE lower(email) = ?', [EMAIL]),
            ("DELETE FROM \"_realtime_nudges\" WHERE scope LIKE 'board:zz%'", []),
    ):
        try:
            db.execute(sql, args)
        except Exception:
            pass
    db.commit()


cleanup()
crashed = None
try:
    print("== unauthenticated ==")
    code, text, _ = call("/api/realtime/nudge?kind=board")
    check("unauthenticated poll is refused (401)", code == 401, f"status {code}")

    print("\n== authenticated ==")
    code, _t, hdrs = call("/api/auth/turso-signup", "POST",
                          {"email": EMAIL, "password": PW})
    cookie = "; ".join(c.split(";")[0] for c in (hdrs.get_all("Set-Cookie") or []))
    check("probe account created with a session", code == 200 and bool(cookie))

    uid = db.execute('SELECT id FROM "_supabase_auth_users" WHERE lower(email) = ?',
                     [EMAIL]).fetchall()
    uid = str(uid[0][0]) if uid else ""
    check("resolved the probe user id", bool(uid))

    code, text, _ = call("/api/realtime/nudge?kind=board", cookie=cookie)
    body = json.loads(text) if code == 200 else {}
    check("poll returns polling=true in Turso mode", body.get("polling") is True,
          f"status {code} body {text[:80]}")
    baseline = body.get("token", "")
    check("first token is empty (no bump yet, so no spurious refresh)",
          baseline == "", f"token={baseline!r}")

    # Server-side bump, the way board-nudge does it.
    db.execute('INSERT INTO "_realtime_nudges" (scope, bumped_at) VALUES (?, ?) '
               "ON CONFLICT(scope) DO UPDATE SET bumped_at = excluded.bumped_at",
               [f"board:{uid}".lower(), "2026-08-07T12:00:00.000Z"])
    db.commit()

    code, text, _ = call("/api/realtime/nudge?kind=board", cookie=cookie)
    after = json.loads(text).get("token", "") if code == 200 else ""
    check("token changes after a bump", after and after != baseline, f"token={after!r}")

    print("\n== scope isolation ==")
    # Bump a DIFFERENT user's scope; this caller must not see it.
    db.execute('INSERT INTO "_realtime_nudges" (scope, bumped_at) VALUES (?, ?) '
               "ON CONFLICT(scope) DO UPDATE SET bumped_at = excluded.bumped_at",
               ["board:zzsomeone-elses-user-id", "2026-08-07T23:59:59.000Z"])
    db.commit()
    code, text, _ = call("/api/realtime/nudge?kind=board", cookie=cookie)
    mine = json.loads(text).get("token", "") if code == 200 else ""
    check("another user's bump does not leak into my token",
          mine == after, f"mine={mine!r} expected={after!r}")

    code, text, _ = call("/api/realtime/nudge?kind=bogus", cookie=cookie)
    check("unknown kind is rejected (400)", code == 400, f"status {code}")
except Exception as exc:  # noqa: BLE001
    import traceback

    crashed = f"{type(exc).__name__}: {exc}"
    traceback.print_exc()
finally:
    cleanup()
    left = db.execute("SELECT count(*) FROM \"_realtime_nudges\" "
                      "WHERE scope LIKE 'board:zz%'").fetchall()[0][0]
    print(f"\ncleanup: probe nudge rows remaining = {left}")
    if crashed:
        print(f"CRASHED: {crashed}")
    print(f"RESULT: {len(passed)} passed, {len(failed)} failed"
          + ("  [INCOMPLETE]" if crashed else ""))
    if failed:
        print("FAILED: " + ", ".join(failed))
    if not passed and not failed:
        print("NO CHECKS RAN — treating as failure.")
    sys.exit(1 if (failed or crashed or not passed) else 0)
