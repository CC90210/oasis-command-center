/**
 * scripts/audit-operator-emails.ts — could a stranger claim an operator alias?
 * (doc 02 P0-7 "Now", 2026-09-28)
 *
 * isOperatorEmail (lib/operator-credentials.ts) trusts three sources: the
 * hardcoded DEFAULT_OPERATOR_EMAIL, OPERATOR_EMAIL, and each entry of
 * ADMIN_EMAILS. An alias that is configured but has NO live auth user is one
 * whoever registers that address first would hold. requireOperator
 * (lib/role-surfaces-session.ts) now also demands an owner/admin OASIS
 * membership by auth id, which closes the cross-tenant escalation — but a
 * dangling alias is still a standing hazard (the invite / Google / relink
 * paths all key on email), so any alias this reports as CLAIMABLE is removed
 * from the Worker env the same day.
 *
 * PRINTS NO EMAIL VALUES. Each alias is named by its source only
 * ("OPERATOR_EMAIL", "ADMIN_EMAILS[2]"), and the only facts reported are
 * booleans. Read-only: one SELECT per alias against "_supabase_auth_users".
 *
 * Env, supplied by the caller — this script opens no credential file:
 *   OPERATOR_EMAIL, ADMIN_EMAILS   exactly as deployed on the Worker
 *   TURSO_DATABASE_URL + TURSO_AUTH_TOKEN, or TURSO_DB_PATH for a local file
 *
 * Exit 0 = no alias is claimable; 1 = at least one is; 2 = the audit itself
 * could not run (missing DB config, lookup error, unparseable default).
 *
 * Run: node --conditions=react-server --import tsx scripts/audit-operator-emails.ts
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Client } from "@libsql/client";
import { isOperatorEmail } from "../lib/operator-credentials";

export type AliasAudit = {
  /** Where the alias is configured. Never the address itself. */
  source: string;
  set: boolean;
  /** A non-deleted auth user holds this address (signup is refused for it). */
  registered: boolean;
  /** registered, and not currently banned. */
  liveAuthUser: boolean;
  /** Configured, and nobody holds the address: first registrant becomes it. */
  claimable: boolean;
};

/**
 * The hardcoded default lives in lib/operator-credentials.ts as an unexported
 * const. Read it from the source rather than retyping it here, so this audit
 * can never check a stale copy; refuse loudly if the declaration moved or if
 * the value read is not one isOperatorEmail accepts.
 */
export function readDefaultOperatorEmail(repoRoot: string): string {
  const src = readFileSync(join(repoRoot, "lib", "operator-credentials.ts"), "utf8");
  const m = src.match(/const DEFAULT_OPERATOR_EMAIL\s*=\s*"([^"]+)"/);
  if (!m) throw new Error("DEFAULT_OPERATOR_EMAIL declaration not found in lib/operator-credentials.ts");
  const value = m[1].trim().toLowerCase();
  if (!isOperatorEmail(value)) {
    throw new Error("the DEFAULT_OPERATOR_EMAIL read from source is not accepted by isOperatorEmail");
  }
  return value;
}

/** Every configured alias source, in the order isOperatorEmail reads them. */
export function operatorAliasSources(
  env: Record<string, string | undefined>,
  defaultEmail: string,
): Array<{ source: string; email: string | null }> {
  const norm = (v: string | undefined) => {
    const e = (v || "").trim().toLowerCase();
    return e || null;
  };
  const out: Array<{ source: string; email: string | null }> = [
    { source: "DEFAULT_OPERATOR_EMAIL (hardcoded)", email: norm(defaultEmail) },
    { source: "OPERATOR_EMAIL", email: norm(env.OPERATOR_EMAIL) },
  ];
  const admins = (env.ADMIN_EMAILS || "").split(",");
  const listed = admins.map(norm).filter((e): e is string => e !== null);
  if (listed.length === 0) out.push({ source: "ADMIN_EMAILS", email: null });
  listed.forEach((email, i) => out.push({ source: `ADMIN_EMAILS[${i + 1}]`, email }));
  return out;
}

export async function auditOperatorAliases(
  db: Pick<Client, "execute">,
  env: Record<string, string | undefined>,
  defaultEmail: string,
  now: Date = new Date(),
): Promise<AliasAudit[]> {
  const results: AliasAudit[] = [];
  for (const { source, email } of operatorAliasSources(env, defaultEmail)) {
    if (!email) {
      results.push({ source, set: false, registered: false, liveAuthUser: false, claimable: false });
      continue;
    }
    // Same predicate turso-signup uses to refuse a duplicate address
    // (lower(email), deleted_at IS NULL), so "claimable" means exactly "signup
    // would accept this address today".
    const res = await db.execute({
      sql: `SELECT banned_until FROM "_supabase_auth_users"
            WHERE lower(email) = ? AND deleted_at IS NULL LIMIT 1`,
      args: [email],
    });
    const row = res.rows[0] as { banned_until?: unknown } | undefined;
    const registered = row !== undefined;
    const bannedUntil = row && typeof row.banned_until === "string" ? Date.parse(row.banned_until) : NaN;
    const banned = Number.isFinite(bannedUntil) && bannedUntil > now.getTime();
    results.push({
      source,
      set: true,
      registered,
      liveAuthUser: registered && !banned,
      claimable: !registered,
    });
  }
  return results;
}

function yn(v: boolean): string {
  return v ? "yes" : "no";
}

async function main(): Promise<number> {
  let defaultEmail: string;
  try {
    defaultEmail = readDefaultOperatorEmail(join(__dirname, ".."));
  } catch (err) {
    console.error(`audit could not run: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }
  const { getTursoClient, tursoConfigured } = await import("../lib/turso");
  if (!tursoConfigured()) {
    console.error(
      "audit could not run: set TURSO_DATABASE_URL + TURSO_AUTH_TOKEN (or TURSO_DB_PATH) for the database to check.",
    );
    return 2;
  }
  let rows: AliasAudit[];
  try {
    rows = await auditOperatorAliases(getTursoClient(), process.env, defaultEmail);
  } catch (err) {
    console.error("audit could not run: auth-user lookup failed");
    console.error(err);
    return 2;
  }

  console.log("OPERATOR ALIAS AUDIT — values are never printed\n");
  console.log(`${"source".padEnd(36)} ${"set".padEnd(4)} ${"live auth user".padEnd(15)} verdict`);
  for (const r of rows) {
    const verdict = !r.set
      ? "-"
      : r.claimable
        ? r.source.startsWith("DEFAULT_")
          ? "CLAIMABLE: hardcoded — needs a code change in lib/operator-credentials.ts"
          : "CLAIMABLE: remove it from the Worker env today"
        : r.liveAuthUser
          ? "held by an existing account"
          : "held by a BANNED account (signup still refused)";
    console.log(
      `${r.source.padEnd(36)} ${yn(r.set).padEnd(4)} ${(r.set ? yn(r.liveAuthUser) : "-").padEnd(15)} ${verdict}`,
    );
  }
  const claimable = rows.filter((r) => r.claimable).length;
  console.log(`\n${claimable} claimable alias(es).`);
  return claimable > 0 ? 1 : 0;
}

// Runs only when invoked as a script, so tests can import the functions above.
if (/audit-operator-emails\.ts$/.test(process.argv[1] || "")) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(err);
      process.exit(2);
    },
  );
}
