/**
 * tests/client-automation-lifecycle.test.ts
 *
 * WHY THIS FILE EXISTS. tests/reply-identity.test.ts proves canActivateProfile()
 * refuses an unverified client domain, and tests/client-automation-profiles.test.ts
 * proves the draft refuses a missing mode. Both test the DECISIONS. Neither
 * tested that the decisions are WIRED IN — deleting the one line in
 * activateClientAutomationProfile() that calls the gate left the whole suite
 * green, and recordDnsVerification(), the only key to that gate, had no coverage
 * at all. A guard nothing pins is a guard the next refactor removes by accident.
 *
 * So this runs the real functions against a real libSQL database built from the
 * real migrations — 148, then a pre-149 row, then 149 and 150 — through the real
 * Turso adapter. No mocks: a mocked `from()` would have been just as green with
 * the gate deleted.
 *
 * It is also the only place the two layers are checked against each other. The
 * app must refuse before the database does, because an operator who gets
 * "CHECK constraint failed: client_automation_profiles_active_needs_dns" has to
 * go read a migration to find out what to do, while the app's message names the
 * missing thing. Every rejection below asserts the TYPE of the error, which is
 * what distinguishes "the app caught it" from "the app let it through and the
 * database caught it".
 */

import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// ---------------------------------------------------------------------------
// A private database, wired in before the module under test is imported
// ---------------------------------------------------------------------------
// TURSO_DB_PATH takes precedence over TURSO_DATABASE_URL in getTursoClient(),
// but the remote vars are deleted anyway: this test writes, and a stray
// credential in the ambient environment must not be able to point those writes
// at the production database. Its own directory per run, because a shared
// fixture namespace is how one test's leftovers silently pass another.
const workdir = mkdtempSync(path.join(tmpdir(), "oasis-profile-lifecycle-"));
const dbPath = path.join(workdir, "profiles.db");
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_DB_URL;
delete process.env.TURSO_AUTH_TOKEN;
delete process.env.BRAVO_SUPABASE_URL;
delete process.env.BRAVO_SUPABASE_SERVICE_ROLE_KEY;
process.env.TURSO_DB_PATH = dbPath;
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";

const repoRoot = path.resolve(__dirname, "..");
const migration = (rel: string) => readFileSync(path.join(repoRoot, rel), "utf8");

const TENANT = "22222222-2222-2222-2222-222222222222";

const INTAKE: Record<string, unknown> = {
  email: "owner@acmeheating.com",
  notification_email: "",
  phone: "+15145550147",
  business_name: "Acme Heating & Cooling",
  what_you_do: "We install and repair residential furnaces and AC units.",
  industry: "HVAC",
  timezone: "America/Toronto",
  top_services: "Furnace installation\nAC repair",
  reply_tone: "friendly",
  never_say: "Never quote a price",
  response_speed: "15",
  website_domain: "acmeheating.com",
  approver_name: "Dana Reyes",
  approver_email: "dana@acmeheating.com",
  send_consent: "agreed",
  consent_signed_name: "Dana Reyes",
};

const db = createClient({ url: `file:${dbPath}` });

/** Best-effort: Windows holds the libSQL file open until the client is closed,
 *  and a cleanup that throws would bury the real failure under an EPERM. */
function cleanup(): void {
  try { db.close(); } catch { /* already closed */ }
  try { rmSync(workdir, { recursive: true, force: true }); } catch { /* leave the temp dir */ }
}

async function main(): Promise<void> {

  // The two tables 148's foreign keys point at. libSQL enforces FKs on a local
  // file — an earlier version of this fixture "passed" every rejection case
  // because every insert was dying on a missing table instead of on the rule
  // under test.
  await db.executeMultiple(
    'CREATE TABLE "tenants" ("id" TEXT PRIMARY KEY);' +
      'CREATE TABLE "tenant_records" ("id" TEXT PRIMARY KEY);' +
      'CREATE TABLE "website_onboarding" ("id" TEXT PRIMARY KEY);',
  );
  await db.execute({ sql: 'INSERT INTO "tenants" ("id") VALUES (?)', args: [TENANT] });
  await db.executeMultiple(migration("database/turso/148_client_automation_profiles.turso.sql"));

  // A PRE-149 ROW, CREATED THE ONLY WAY ONE EVER REALLY IS: written while the
  // column did not exist yet. 149 then has to apply over it — which is the case
  // its no-backfill design is for, and the case a fresh-database test never
  // reaches.
  await db.execute({
    sql:
      'INSERT INTO "client_automation_profiles" ' +
      '("id","tenant_id","client_name","website_domain","reply_from_identity",' +
      '"ingest_key_hash","cc_emails","send_consent_at","status") ' +
      "VALUES (?,?,?,?,?,?,?,?,?)",
    args: [
      "legacy-profile", TENANT, "Legacy Co", "legacy.example.com", "support@oasisai.work",
      "a".repeat(64), '["owner@legacy.example.com"]', "2026-01-01T00:00:00.000Z", "pending",
    ],
  });

  await db.executeMultiple(migration("database/turso/149_reply_identity_mode.turso.sql"));
  await db.executeMultiple(migration("database/turso/150_reply_identity_pairing.turso.sql"));

  const legacy = await db.execute(
    "SELECT \"reply_identity_mode\" FROM \"client_automation_profiles\" WHERE \"id\"='legacy-profile'",
  );
  assert.equal(
    legacy.rows[0].reply_identity_mode,
    null,
    "149 and 150 apply over an existing row and do NOT invent a mode for it",
  );

  const {
    provisionClientAutomationProfile,
    activateClientAutomationProfile,
    recordDnsVerification,
    ProfileDraftError,
  } = await import("../lib/client-automation-profiles");

  const provision = (over: Record<string, unknown>, opts: Record<string, unknown>) =>
    provisionClientAutomationProfile({ ...INTAKE, ...over }, {
      tenantId: TENANT,
      ...opts,
    } as Parameters<typeof provisionClientAutomationProfile>[1]);

  // -------------------------------------------------------------------------
  // The expensive mode: the client's own domain, before its DNS exists
  // -------------------------------------------------------------------------
  const own = await provision({}, {
    replyFromIdentity: "hello@acmeheating.com",
    replyIdentityMode: "per_client_domain",
  });
  assert.equal(own.profile.status, "pending", "provisioning never activates");
  assert.equal(own.profile.reply_identity_mode, "per_client_domain", "the decision is stored");
  assert.equal(own.profile.dns_verified_at, null, "and nothing has verified the client's DNS");
  assert.ok(own.ingestKey.startsWith("oasis_ing_"), "the raw key comes back exactly once");

  // THE MUTATION THAT USED TO SURVIVE. Delete the canActivateProfile() call from
  // activateClientAutomationProfile() and this assertion fails: the row still
  // cannot go active — migration 149's CHECK stops it — but the failure arrives
  // as a raw dbError naming a constraint instead of a ProfileDraftError naming
  // the missing DNS records. Asserting the type is what makes the wiring, not
  // just the rule, load-bearing.
  await assert.rejects(
    () => activateClientAutomationProfile({ id: own.profile.id, tenantId: TENANT }),
    (err: unknown) => {
      assert.ok(err instanceof ProfileDraftError,
        `the APP must refuse first — got ${(err as Error)?.constructor?.name}: ${(err as Error)?.message?.slice(0, 120)}`);
      const m = (err as Error).message;
      for (const record of ["SPF", "DKIM", "DMARC"]) {
        assert.ok(m.includes(record), `names ${record}, the thing that is actually missing`);
      }
      assert.ok(!/CHECK constraint/i.test(m), "and not by quoting a constraint name at an operator");
      return true;
    },
  );

  // The row is untouched by the refusal — a blocked activation must not leave a
  // half-flipped profile behind.
  const afterBlock = await db.execute({
    sql: 'SELECT "status","activated_at" FROM "client_automation_profiles" WHERE "id"=?',
    args: [own.profile.id],
  });
  assert.equal(afterBlock.rows[0].status, "pending");
  assert.equal(afterBlock.rows[0].activated_at, null);

  // -------------------------------------------------------------------------
  // The key to the gate: recording the DNS verification
  // -------------------------------------------------------------------------
  // A NOTE IS NOT AN ATTESTATION. Until this check existed, "no" was stored
  // verbatim and then satisfied the activation gate, because the gate only asked
  // whether the column was non-empty.
  for (const note of ["no", "not verified yet", "2026-08-20"]) {
    await assert.rejects(
      () => recordDnsVerification({ id: own.profile.id, tenantId: TENANT, verifiedAt: note }),
      (err: unknown) =>
        err instanceof ProfileDraftError && /is not a verification time/.test((err as Error).message),
      `verifiedAt ${JSON.stringify(note)} is refused`,
    );
  }
  const stillNull = await db.execute({
    sql: 'SELECT "dns_verified_at" FROM "client_automation_profiles" WHERE "id"=?',
    args: [own.profile.id],
  });
  assert.equal(stillNull.rows[0].dns_verified_at, null, "and nothing was written while refusing");

  const verified = await recordDnsVerification({
    id: own.profile.id,
    tenantId: TENANT,
    verifiedAt: "2026-08-19T14:30:00.000Z",
  });
  assert.equal(verified.dns_verified_at, "2026-08-19T14:30:00.000Z",
    "a check done yesterday is recorded as yesterday, not as now");

  const live = await activateClientAutomationProfile({ id: own.profile.id, tenantId: TENANT });
  assert.equal(live.status, "active", "verified DNS unblocks the client's own domain");
  assert.ok(live.activated_at, "and stamps when it went live");

  // -------------------------------------------------------------------------
  // The OASIS-owned modes: nothing to verify, and saying so honestly
  // -------------------------------------------------------------------------
  const shared = await provision(
    { website_domain: "acmeplumbing.com", email: "owner@acmeplumbing.com" },
    { replyFromIdentity: "support@oasisai.work", replyIdentityMode: "shared_oasis" },
  );
  await assert.rejects(
    () => recordDnsVerification({ id: shared.profile.id, tenantId: TENANT }),
    (err: unknown) =>
      err instanceof ProfileDraftError &&
      /no client DNS to verify/.test((err as Error).message) &&
      /shared_oasis/.test((err as Error).message),
    "recording DNS against an OASIS-owned mode is a category error, and the refusal names it",
  );
  const sharedLive = await activateClientAutomationProfile({
    id: shared.profile.id,
    tenantId: TENANT,
  });
  assert.equal(sharedLive.status, "active", "shared_oasis needs no client DNS at all");

  // A PRE-149 PROFILE IS UNDECIDED, NOT OASIS-OWNED. This message used to read
  // "this profile is on null, which sends from an OASIS-owned domain — nothing
  // is blocking activation on it", which was false twice: nobody chose a mode,
  // and a mode-less profile cannot be activated either.
  await assert.rejects(
    () => recordDnsVerification({ id: "legacy-profile", tenantId: TENANT }),
    (err: unknown) => {
      assert.ok(err instanceof ProfileDraftError);
      const m = (err as Error).message;
      assert.ok(/no reply identity mode recorded/.test(m), "says what is actually true");
      assert.ok(!/OASIS-owned/.test(m), "and does not claim a mode it does not have");
      return true;
    },
  );
  await assert.rejects(
    () => activateClientAutomationProfile({ id: "legacy-profile", tenantId: TENANT }),
    (err: unknown) =>
      err instanceof ProfileDraftError && /reply identity mode/.test((err as Error).message),
    "a profile nobody decided cannot go live on a guess",
  );

  // -------------------------------------------------------------------------
  // The database backstop (150), and the app gate that stands in front of it
  // -------------------------------------------------------------------------
  const drifting = await provision(
    { website_domain: "acmeroofing.com", email: "owner@acmeroofing.com" },
    { replyFromIdentity: "support@oasisai.work", replyIdentityMode: "shared_oasis" },
  );

  // The blank attestation 149 accepted. Its CHECK asks only IS NOT NULL, and the
  // column is TEXT here (timestamptz in the Postgres twin), so '' and the words
  // "not verified yet" both fit — and both read as verification to the guard.
  for (const note of ["", "not verified yet"]) {
    await assert.rejects(
      () =>
        db.execute({
          sql: 'UPDATE "client_automation_profiles" SET "dns_verified_at"=? WHERE "id"=?',
          args: [note, own.profile.id],
        }),
      /ISO-8601/,
      `150 refuses dns_verified_at ${JSON.stringify(note)} at the database`,
    );
  }

  // Two clients on the identical subaddress silently share the analytics lane
  // the mode is sold on. Nothing in the product would ever report it.
  await provision(
    { website_domain: "acmeglass.com", email: "owner@acmeglass.com" },
    { replyFromIdentity: "support+acmeglass@oasisai.work", replyIdentityMode: "per_client_subaddress" },
  );
  await assert.rejects(
    () =>
      provision(
        { website_domain: "acmeglass.ca", email: "owner@acmeglass.ca" },
        {
          replyFromIdentity: "SUPPORT+ACMEGLASS@oasisai.work",
          replyIdentityMode: "per_client_subaddress",
        },
      ),
    /UNIQUE|per_client_identity/i,
    "150 refuses a second client on an address that already identifies one",
  );

  // Each pairing rule, exercised through a raw INSERT — the writer 150 exists
  // for. Asserted behaviourally rather than by grepping the migration for a mode
  // id: every id also appears in the uniqueness index and the header, so a
  // string search reports coverage for a rule that has been deleted.
  const rawInsert = (over: Record<string, unknown>) => {
    const row: Record<string, unknown> = {
      id: randomUUID(),
      tenant_id: TENANT,
      client_name: "Raw Co",
      website_domain: `${randomUUID().slice(0, 8)}.example.com`,
      reply_from_identity: "support@oasisai.work",
      reply_identity_mode: "shared_oasis",
      ingest_key_hash: randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, ""),
      cc_emails: '["owner@example.com"]',
      send_consent_at: "2026-08-01T00:00:00.000Z",
      status: "pending",
      ...over,
    };
    const keys = Object.keys(row);
    return db.execute({
      sql:
        `INSERT INTO "client_automation_profiles" (${keys.map((k) => `"${k}"`).join(",")}) ` +
        `VALUES (${keys.map(() => "?").join(",")})`,
      args: keys.map((k) => row[k] as string),
    });
  };
  for (const [label, over] of [
    ["shared_oasis on a client's own domain", { reply_from_identity: "hello@acmeroofing.com" }],
    ["shared_oasis on a lookalike of the OASIS domain",
      { reply_from_identity: "support@evil-oasisai.work" }],
    ["shared_oasis carrying a +tag", { reply_from_identity: "support+acme@oasisai.work" }],
    ["per_client_subaddress with no tag",
      { reply_identity_mode: "per_client_subaddress", reply_from_identity: "support@oasisai.work" }],
    ["per_client_domain pointed back at oasisai.work",
      { reply_identity_mode: "per_client_domain", reply_from_identity: "support@oasisai.work" }],
    ["per_client_domain on a third party's domain",
      { reply_identity_mode: "per_client_domain", website_domain: "acmefencing.com",
        reply_from_identity: "hello@some-other-shop.com" }],
    ["the display-name form in the column",
      { reply_from_identity: "OASIS Support <support@oasisai.work>" }],
  ] as [string, Record<string, unknown>][]) {
    await assert.rejects(
      () => rawInsert(over),
      /oasisai\.work|plus tag|website_domain|bare mailbox/i,
      `150 refuses ${label} at the database`,
    );
  }
  // …and still accepts every legal shape, including the subdomain forms.
  await rawInsert({ reply_from_identity: "support@mail.oasisai.work" });
  await rawInsert({
    reply_identity_mode: "per_client_domain",
    website_domain: "acmesiding.com",
    reply_from_identity: "hello@mail.acmesiding.com",
  });

  // 150 refuses to let the pairing drift in the first place.
  await assert.rejects(
    () =>
      db.execute({
        sql: 'UPDATE "client_automation_profiles" SET "reply_from_identity"=? WHERE "id"=?',
        args: ["hello@acmeroofing.com", drifting.profile.id],
      }),
    /identity|oasisai\.work/i,
    "150 blocks an UPDATE that walks the address off its mode",
  );

  // AND the app refuses independently — which matters because 150 is authored,
  // not applied: until someone runs it, this is the only layer standing between
  // a hand-edited row and mail sent as a domain OASIS does not control.
  await db.executeMultiple(
    'DROP TRIGGER "client_automation_profiles_identity_pairing_on_update";' +
      'DROP TRIGGER "client_automation_profiles_identity_pairing_on_insert";',
  );
  await db.execute({
    sql: 'UPDATE "client_automation_profiles" SET "reply_from_identity"=? WHERE "id"=?',
    args: ["hello@acmeroofing.com", drifting.profile.id],
  });
  await assert.rejects(
    () => activateClientAutomationProfile({ id: drifting.profile.id, tenantId: TENANT }),
    (err: unknown) =>
      err instanceof ProfileDraftError && /no longer matches its mode/.test((err as Error).message),
    "activation re-derives the pairing from what is stored, on a database with only 149 applied",
  );

  console.log("client-automation-lifecycle ok");
}

main().then(cleanup, (err) => {
  cleanup();
  console.error(err);
  process.exitCode = 1;
});
