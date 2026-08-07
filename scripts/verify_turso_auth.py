"""Exercise every Turso auth route end-to-end against a locally-running build.

"It compiles" is not "it works". These five routes are what stands between the
operator and being locked out of the dashboard the day Supabase is cancelled, so
each one gets executed, not merely type-checked:

    turso-signup            create an account, receive a session
    turso-me                that session resolves to the right user
    turso-login             the password just created actually authenticates
    turso-change-password   current password required; wrong one rejected
    turso-reset-request     always 200, never reveals whether an account exists
    turso-reset-confirm     token is single-use; the new password then works

HOW TO RUN (all three flags, or the routes 404 and every check "passes" by
being skipped):

    npm run build
    EMPIRE_DATA_BACKEND=turso_cloud EMPIRE_AUTH_BACKEND=turso \
      AUTH_SESSION_SECRET=<32+ chars> \
      TURSO_DATABASE_URL=... TURSO_AUTH_TOKEN=... npm run start -- -p 3210
    python scripts/verify_turso_auth.py

Everything it creates is prefixed zzauthprobe- and deleted in a finally block.
"""
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path

BASE = "http://localhost:3210"
EMAIL = "zzauthprobe@example.invalid"
PW1 = "ProbePassword!2026"
PW2 = "SecondPassword!2026"
PW3 = "ThirdPassword!2026"

sys.path.insert(0, str(Path(r"C:\Users\User\Business-Empire-Agent\scripts").resolve()))
from lib.tls_trust import ensure_os_trust  # noqa: E402

ensure_os_trust()
import libsql  # noqa: E402

from lib.db_turso import resolve_project_target  # noqa: E402

url, tok, _ = resolve_project_target("bravo")
db = libsql.connect(database=url, auth_token=tok)

passed: list[str] = []
failed: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> None:
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
                timeout=60) as r:
            return r.status, r.read(3000).decode("utf-8", "replace"), r.headers
    except urllib.error.HTTPError as e:
        return e.code, e.read(3000).decode("utf-8", "replace"), e.headers
    except Exception as exc:
        return 0, f"CONNECT-FAIL {exc}", None


def cookies_from(hdrs) -> str:
    if hdrs is None:
        return ""
    # get_all: several Set-Cookie headers are normal and dict() keeps only the
    # last, which is how a session cookie goes missing.
    return "; ".join(c.split(";")[0] for c in (hdrs.get_all("Set-Cookie") or []))


def cleanup():
    for sql, args in (
            ('DELETE FROM "_auth_tokens" WHERE lower(email) = ?', [EMAIL]),
            ('DELETE FROM "_supabase_auth_users" WHERE lower(email) = ?', [EMAIL])):
        try:
            db.execute(sql, args)
        except Exception:
            pass
    db.commit()


cleanup()
crashed: str | None = None
try:
    code, text, _ = call("/api/auth/turso-me")
    mode = (json.loads(text).get("mode") if code == 200 else None)
    # Recorded as a FAILED check, not a bare SystemExit. The first version
    # raised here, the finally block ran, and `sys.exit(1 if failed else 0)`
    # turned "nothing was tested" into exit 0 with "0 passed, 0 failed" — a
    # green result produced by skipping every assertion.
    check("Turso auth is active (all three flags set)", mode == "turso",
          f"turso-me -> {code} mode={mode!r}")
    if mode != "turso":
        print("\nSTOP: every route below would 404 and 'pass' by not running. "
              "Start the server with EMPIRE_DATA_BACKEND, EMPIRE_AUTH_BACKEND "
              "and AUTH_SESSION_SECRET.")
        raise SystemExit(2)

    print("\n== signup ==")
    code, text, hdrs = call("/api/auth/turso-signup", "POST",
                            {"email": EMAIL, "password": PW1, "full_name": "Probe"})
    session = cookies_from(hdrs)
    check("signup returns 200", code == 200, text[:90])
    check("signup sets a session cookie", bool(session))

    code, text, _ = call("/api/auth/turso-me", cookie=session)
    who = json.loads(text).get("user") if code == 200 else None
    check("turso-me resolves the new session", bool(who) and who.get("email") == EMAIL,
          json.dumps(who))

    code, text, _ = call("/api/auth/turso-signup", "POST",
                         {"email": EMAIL, "password": PW1})
    check("duplicate signup is refused (409)", code == 409, text[:70])

    print("\n== login ==")
    code, text, hdrs = call("/api/auth/turso-login", "POST",
                            {"email": EMAIL, "password": PW1})
    login_session = cookies_from(hdrs)
    check("login with the signup password works", code == 200 and bool(login_session))
    code, text, _ = call("/api/auth/turso-login", "POST",
                         {"email": EMAIL, "password": "wrong-password"})
    check("wrong password rejected (401)", code == 401)

    print("\n== change password ==")
    code, text, _ = call("/api/auth/turso-change-password", "POST",
                         {"currentPassword": "not-it", "newPassword": PW2},
                         cookie=login_session)
    check("wrong current password rejected (401)", code == 401, text[:70])
    code, text, _ = call("/api/auth/turso-change-password", "POST",
                         {"currentPassword": PW1, "newPassword": PW2},
                         cookie=login_session)
    check("correct current password accepted", code == 200, text[:70])
    code, _t, _ = call("/api/auth/turso-login", "POST", {"email": EMAIL, "password": PW2})
    check("new password authenticates", code == 200)
    code, _t, _ = call("/api/auth/turso-login", "POST", {"email": EMAIL, "password": PW1})
    check("old password no longer works", code == 401)
    code, text, _ = call("/api/auth/turso-change-password", "POST",
                         {"currentPassword": PW2, "newPassword": PW3})
    check("change-password without a session rejected (401)", code == 401)

    print("\n== password reset ==")
    code, text, _ = call("/api/auth/turso-reset-request", "POST", {"email": EMAIL})
    check("reset-request returns 200", code == 200)
    code, text, _ = call("/api/auth/turso-reset-request", "POST",
                         {"email": "definitely-not-a-user@example.invalid"})
    check("unknown address gets the SAME 200 (no enumeration)", code == 200)

    row = db.execute(
        'SELECT token_hash FROM "_auth_tokens" WHERE lower(email) = ? '
        "AND purpose = 'password_reset' AND used_at IS NULL", [EMAIL]).fetchall()
    check("a reset token was stored for the real address", bool(row))
    # The raw token only ever exists in the email, so redeem via a token we mint
    # ourselves the same way the route does — this proves the CAS + password
    # write, which is the part that can silently corrupt an account.
    import hashlib
    import secrets
    raw = secrets.token_urlsafe(32)
    h = hashlib.sha256(raw.encode()).hexdigest()
    # ISO-8601, matching what turso-reset-request writes. The first version used
    # SQLite's datetime(), and TEXT comparison put ' ' before 'T' — so a token
    # valid for another hour read as expired. The route now compares with
    # unixepoch() on both sides, but minting in the real format keeps this test
    # exercising the real path rather than the tolerance.
    db.execute(
        'INSERT INTO "_auth_tokens" (token_hash, email, purpose, expires_at, created_at) '
        "VALUES (?, ?, 'password_reset', "
        "strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 hour'), "
        "strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
        [h, EMAIL])
    db.commit()

    code, text, _ = call("/api/auth/turso-reset-confirm", "POST",
                         {"token": raw, "password": PW3})
    check("reset-confirm accepts a valid token", code == 200, text[:70])
    code, _t, _ = call("/api/auth/turso-login", "POST", {"email": EMAIL, "password": PW3})
    check("password after reset authenticates", code == 200)
    code, text, _ = call("/api/auth/turso-reset-confirm", "POST",
                         {"token": raw, "password": "YetAnother!2026"})
    check("the same token cannot be reused (single-use)", code == 400, text[:70])
    code, _t, _ = call("/api/auth/turso-login", "POST", {"email": EMAIL, "password": PW3})
    check("password unchanged after the replay attempt", code == 200)
    code, text, _ = call("/api/auth/turso-reset-confirm", "POST",
                         {"token": "not-a-real-token", "password": "Whatever!2026"})
    check("a bogus token is refused", code == 400)
except SystemExit:
    raise
except Exception as exc:  # noqa: BLE001
    # An exception used to reach the finally, which exited 0 because `failed`
    # was empty — a crash reported as success. Record it so the exit code is
    # honest about "this did not finish".
    import traceback

    crashed = f"{type(exc).__name__}: {exc}"
    traceback.print_exc()
finally:
    cleanup()
    left = db.execute('SELECT count(*) FROM "_supabase_auth_users" '
                      "WHERE lower(email) = ?", [EMAIL]).fetchall()[0][0]
    print(f"\ncleanup: probe accounts remaining = {left}")
    if crashed:
        print(f"CRASHED before finishing: {crashed}")
    print(f"RESULT: {len(passed)} passed, {len(failed)} failed"
          + ("  [INCOMPLETE]" if crashed else ""))
    if failed:
        print("FAILED: " + ", ".join(failed))
    # No checks at all is a failure, not a pass. A harness that asserts nothing
    # and exits 0 is worse than no harness — it manufactures confidence.
    if not passed and not failed:
        print("NO CHECKS RAN — treating as failure.")
    sys.exit(1 if (failed or crashed or not passed) else 0)
