import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createClient } from "@libsql/client";
import {
  signSession,
  verifySession,
  verifySessionAgainstDb,
  type TursoSession,
} from "../lib/turso-auth";

async function main() {
  const previousSecret = process.env.AUTH_SESSION_SECRET;
  process.env.AUTH_SESSION_SECRET = "session-version-test-secret-that-is-deliberately-long-enough-0001";
  const db = createClient({ url: ":memory:" });

  try {
    await db.execute(`CREATE TABLE "_supabase_auth_users" (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      session_version INTEGER NOT NULL DEFAULT 0,
      banned_until TEXT,
      deleted_at TEXT
    )`);
    await db.execute(`INSERT INTO "_supabase_auth_users" (id, email)
      VALUES ('auth-david', 'David@OasisAI.Work')`);

    // Simulate a cookie minted by the pre-migration application. Missing `ver`
    // intentionally normalizes to zero so the deployment itself is not a
    // fleet-wide logout.
    const legacy = signSession({
      sub: "auth-david",
      email: "stale-case@example.com",
      exp: Math.floor(Date.now() / 1000) + 3600,
    } as TursoSession);
    assert.equal(verifySession(legacy)?.ver, 0);
    const acceptedLegacy = await verifySessionAgainstDb(db, legacy);
    assert.equal(acceptedLegacy?.email, "david@oasisai.work", "database email is canonical");

    await db.execute(`UPDATE "_supabase_auth_users" SET session_version = 1
      WHERE id = 'auth-david'`);
    assert.equal(
      await verifySessionAgainstDb(db, legacy),
      null,
      "incrementing the account epoch revokes every older cookie",
    );

    const current = signSession({
      sub: "auth-david",
      email: "david@oasisai.work",
      exp: Math.floor(Date.now() / 1000) + 3600,
      ver: 1,
    });
    assert.equal((await verifySessionAgainstDb(db, current))?.ver, 1);

    await db.execute(`UPDATE "_supabase_auth_users"
      SET banned_until = '2099-01-01T00:00:00.000Z' WHERE id = 'auth-david'`);
    assert.equal(await verifySessionAgainstDb(db, current), null, "a banned account is inert");

    const migration = readFileSync("database/turso/168_auth_session_version.turso.sql", "utf8");
    assert(migration.includes('ADD COLUMN "session_version" INTEGER NOT NULL DEFAULT 0'));
    const reset = readFileSync("app/api/auth/turso-reset-confirm/route.ts", "utf8");
    const change = readFileSync("app/api/auth/turso-change-password/route.ts", "utf8");
    const identity = readFileSync("lib/supabase-server.ts", "utf8");
    const me = readFileSync("app/api/auth/turso-me/route.ts", "utf8");
    assert(reset.includes("session_version = session_version + 1"));
    assert(change.includes("session_version = session_version + 1"));
    assert(change.includes('code: "password_reset_required"'));
    assert(
      change.indexOf("if (!hasPassword)") < change.indexOf("await verifyPassword"),
      "Google-only accounts must step up through email before creating a password",
    );
    assert(identity.includes("verifySessionAgainstDb"));
    assert(me.includes("verifySessionAgainstDb"));

    console.log("Turso session-version tests passed");
  } finally {
    db.close();
    if (previousSecret === undefined) delete process.env.AUTH_SESSION_SECRET;
    else process.env.AUTH_SESSION_SECRET = previousSecret;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
