/**
 * consent-ledger.test.ts — the consent ledger (database/turso/bravo__214_
 * consent_events.sql, lib/consent/ledger*.ts), V0 slice 2026-10-11.
 *
 * WHAT IS PINNED:
 *   1. The disclosure text names the business, its address, how to
 *      unsubscribe, and the privacy link, for both channels — and is
 *      identical whether the identity came from a mapped brand or the
 *      generic fallback (same function, same template).
 *   2. renderedChannelsForStep / consentDecisionsForStep: a step's own field
 *      types decide which channels exist; a forged extra channel in the
 *      caller's "requested" map is never looked at; a missing/non-true
 *      value for a channel the step DOES render reads as unticked, never
 *      as a default "yes".
 *   3. recordConsentEvents: one row per rendered channel, the IP recorded
 *      is EXACTLY the caller's ipAddress argument (the submit route's only
 *      source for that argument is Cloudflare's header, never the body —
 *      pinned separately as a source check on the route), disclosure_hash
 *      is sha256 of the server's own rendered text, never anything a
 *      caller supplies (the function signature has no text/hash parameter
 *      at all).
 *   4. No update or delete path: the migration's two triggers exist and
 *      abort any attempt; lib/consent/ledger.ts never chains .update(/
 *      .delete( off a consent_events access.
 *   5. hasTickedConsent / marketingSendAllowed: no row refuses; the most
 *      RECENT row wins (a later decline overrides an earlier tick); a read
 *      error refuses (fail closed) rather than throwing or defaulting to
 *      allow.
 *   6. Workspace isolation: the same lead id under two different tenants
 *      never sees the other tenant's consent.
 *   7. Transactional sends (the ai-audit welcome email) do not import or
 *      call the consent gate at all — a source check, because a gate a
 *      transactional reply is routed through would refuse to answer an
 *      enquiry over a marketing preference, which the design forbids.
 *
 * Run: node --conditions=react-server --import tsx tests/consent-ledger.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { check, finish, setupDatabase } from "./_delivery-harness";

const ROOT = join(__dirname, "..");
const CONSENT_MIGRATION_PATH = join(ROOT, "database", "turso", "bravo__214_consent_events.sql");

const TENANT_A = "cccccccc-0000-4000-8000-0000000000a1";
const TENANT_B = "cccccccc-0000-4000-8000-0000000000b2";
const LEAD_SHARED = "lead-shared-0001"; // deliberately reused across tenants below

async function main() {
  const db = await setupDatabase();
  // consent_events is not part of the shared delivery harness — apply the
  // real migration file, statement by statement including its triggers,
  // the same way bravo__190_ledger_core.sql (which also has multi-line
  // trigger bodies) is already applied in this harness.
  await db.executeMultiple(readFileSync(CONSENT_MIGRATION_PATH, "utf8"));
  await db.execute({
    sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'client-a', 'Client A')",
    args: [TENANT_A],
  });
  await db.execute({
    sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'client-b', 'Client B')",
    args: [TENANT_B],
  });

  const { getServiceSupabase } = await import("../lib/supabase-server");
  const { resolveConsentIdentity } = await import("../lib/consent/ledger-identity");
  const {
    consentDisclosureText,
    renderedChannelsForStep,
    consentDecisionsForStep,
    CONSENT_DISCLOSURE_VERSION,
  } = await import("../lib/consent/ledger-disclosure");
  const { recordConsentEvents, hasTickedConsent, sha256Hex } = await import("../lib/consent/ledger");
  const { marketingSendAllowed } = await import("../lib/consent/marketing-send-gate");
  const { getBrand } = await import("../lib/email/brands");

  console.log("consent-ledger:");

  // ── 1. Disclosure text names the business, address, unsubscribe, privacy ──
  await check("email disclosure names the business, address, STOP-equivalent and privacy link", () => {
    const identity = { businessName: "Acme Co", address: "1 Main St, Springfield", privacyUrl: "https://example.test/privacy" };
    const text = consentDisclosureText("email", identity);
    assert.ok(text.includes("Acme Co"));
    assert.ok(text.includes("1 Main St, Springfield"));
    assert.ok(/unsubscribe/i.test(text));
    assert.ok(text.includes("https://example.test/privacy"));
  });

  await check("sms disclosure names the business, address, STOP and privacy link", () => {
    const identity = { businessName: "Acme Co", address: "1 Main St, Springfield", privacyUrl: "https://example.test/privacy" };
    const text = consentDisclosureText("sms", identity);
    assert.ok(text.includes("Acme Co"));
    assert.ok(text.includes("1 Main St, Springfield"));
    assert.ok(/stop/i.test(text));
    assert.ok(text.includes("https://example.test/privacy"));
  });

  await check("resolveConsentIdentity: a mapped tenant (OASIS) resolves from the brand registry", () => {
    const oasis = getBrand("oasis");
    const { identity, source } = resolveConsentIdentity({
      tenantId: "ef8d389e-3f15-43f2-ae00-3660f69a1452",
      tenantSlug: "oasis-ai-cc",
    });
    assert.equal(source, "brand");
    assert.equal(identity.businessName, oasis.legalName);
    assert.equal(identity.address, oasis.postalAddress);
  });

  await check("resolveConsentIdentity: an unmapped tenant fails closed to the generic (OASIS) identity, flagged as such", () => {
    const oasis = getBrand("oasis");
    const { identity, source } = resolveConsentIdentity({
      tenantId: "99999999-0000-4000-8000-000000000099",
      tenantSlug: "some-self-signup-workspace",
    });
    assert.equal(source, "generic_fallback");
    assert.equal(identity.businessName, oasis.legalName);
    assert.equal(identity.address, oasis.postalAddress);
  });

  // ── 2. Channel derivation + forged-channel / tampered-claim resistance ──
  const stepBoth = {
    key: "identity",
    title: "Who am I talking to?",
    fields: [
      { name: "email", label: "Email", type: "email" as const },
      { name: "phone", label: "Phone", type: "phone" as const },
    ],
  };
  const stepEmailOnly = {
    key: "identity",
    title: "Who am I talking to?",
    fields: [{ name: "email", label: "Email", type: "email" as const }],
  };
  const stepNeither = {
    key: "more",
    title: "More",
    fields: [{ name: "notes", label: "Notes", type: "textarea" as const }],
  };

  await check("renderedChannelsForStep: both field types present renders both channels", () => {
    assert.deepEqual(renderedChannelsForStep(stepBoth, {}), ["email", "sms"]);
  });
  await check("renderedChannelsForStep: a step with neither field type renders no channel", () => {
    assert.deepEqual(renderedChannelsForStep(stepNeither, {}), []);
  });

  await check("consentDecisionsForStep: a forged extra channel (sms) the step never rendered is ignored", () => {
    const decisions = consentDecisionsForStep(stepEmailOnly, {}, { email: true, sms: true });
    assert.deepEqual(decisions, [{ channel: "email", ticked: true }]);
    assert.ok(!decisions.some((d) => d.channel === "sms"), "a channel this step did not render must never be recorded");
  });

  await check("consentDecisionsForStep: a missing or non-true claim for a rendered channel reads as unticked, never a default yes", () => {
    assert.deepEqual(consentDecisionsForStep(stepBoth, {}, {}), [
      { channel: "email", ticked: false },
      { channel: "sms", ticked: false },
    ]);
    assert.deepEqual(consentDecisionsForStep(stepBoth, {}, { email: "yes" }), [
      { channel: "email", ticked: false },
      { channel: "sms", ticked: false },
    ]);
  });

  // ── 3. recordConsentEvents: one row per channel; server-computed hash; IP is exactly the caller's argument ──
  const dbClient = getServiceSupabase();
  const identity = { businessName: "Test Co", address: "9 Test Ave", privacyUrl: "https://test.example/privacy" };

  await check("recordConsentEvents inserts one row per decision, with the server-rendered text and its own hash, and the caller's IP verbatim", async () => {
    const result = await recordConsentEvents(dbClient, {
      tenantId: TENANT_A,
      leadId: LEAD_SHARED,
      formId: "form-1",
      decisions: [
        { channel: "email", ticked: true },
        { channel: "sms", ticked: false },
      ],
      identity,
      identitySource: "brand",
      ipAddress: "203.0.113.9",
      userAgent: "test-agent/1.0",
      pageUrl: "https://test.example/f/a/form-1",
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.recorded.sort(), ["email", "sms"]);

    const rows = await dbClient
      .from("consent_events")
      .select("channel, ticked, ip_address, user_agent, page_url, disclosure_text, disclosure_hash, disclosure_version")
      .eq("tenant_id", TENANT_A)
      .eq("lead_id", LEAD_SHARED)
      .eq("form_id", "form-1");
    assert.equal(rows.error, null);
    const data = (rows.data || []) as Array<Record<string, unknown>>;
    assert.equal(data.length, 2);

    for (const row of data) {
      const channel = row.channel as "email" | "sms";
      const expectedText = consentDisclosureText(channel, identity);
      assert.equal(row.disclosure_text, expectedText);
      assert.equal(row.disclosure_hash, sha256Hex(expectedText));
      assert.equal(row.disclosure_hash, createHash("sha256").update(expectedText, "utf8").digest("hex"));
      assert.equal(row.disclosure_version, CONSENT_DISCLOSURE_VERSION);
      assert.equal(row.ip_address, "203.0.113.9", "the body's own ip must never override the caller-supplied header IP");
      assert.equal(row.user_agent, "test-agent/1.0");
      assert.equal(row.page_url, "https://test.example/f/a/form-1");
      const expectTicked = channel === "email" ? 1 : 0;
      assert.equal(row.ticked, expectTicked);
    }
  });

  // ── 3b. Source pin: the route's ONLY source for ipAddress is the header-
  // derived variable, never anything read off the request body ──
  await check("the submit route's consent-ledger call passes the header-derived IP, never a body field", () => {
    const src = readFileSync(join(ROOT, "app", "api", "forms", "submit", "route.ts"), "utf8");
    const anchor = src.indexOf("recordConsentEvents(db, {");
    assert.ok(anchor >= 0, "recordConsentEvents call not found in the submit route");
    const block = src.slice(anchor, anchor + 400);
    assert.ok(/ipAddress:\s*ipHeader\b/.test(block), `expected ipAddress: ipHeader in:\n${block}`);
    assert.ok(!/body\.ip\b|body\["ip"\]|body\.ip_address/.test(block), "the ledger write must never read an IP off the request body");
    // ipHeader itself must trace to the header-reading helper, not the body —
    // getClientIp(req) reads the request's headers (cf-connecting-ip),
    // confirmed in lib/api-helpers.ts; it is never passed `body`.
    assert.ok(/const resolvedIp = getClientIp\(req\);/.test(src));
    assert.ok(/const ipHeader = resolvedIp === "unknown" \? null : resolvedIp;/.test(src));
  });

  // ── 4. No update/delete path ──
  await check("the migration's two triggers exist and abort any UPDATE/DELETE; the table has no literal mutating statement", () => {
    const sql = readFileSync(CONSENT_MIGRATION_PATH, "utf8");
    assert.equal((sql.match(/RAISE\(ABORT/g) || []).length, 2);
    assert.ok(/BEFORE UPDATE ON consent_events/.test(sql));
    assert.ok(/BEFORE DELETE ON consent_events/.test(sql));
    assert.ok(!/UPDATE consent_events SET/i.test(sql), "no literal mutating UPDATE statement against the table");
    assert.ok(!/DELETE FROM consent_events/i.test(sql), "no literal mutating DELETE statement against the table");
  });

  await check("lib/consent/ledger.ts never chains .update(/.delete( off a consent_events access", () => {
    const src = readFileSync(join(ROOT, "lib", "consent", "ledger.ts"), "utf8");
    const re = /\.from\(\s*["']consent_events["']\s*\)([^;]{0,120})/g;
    let m: RegExpExecArray | null;
    let found = 0;
    while ((m = re.exec(src))) {
      found += 1;
      assert.ok(!/\.update\(|\.delete\(/.test(m[1]), `consent_events access followed by a mutation: ${m[1].slice(0, 80)}`);
    }
    assert.ok(found >= 2, "expected at least the insert (recordConsentEvents) and select (hasTickedConsent) accesses");
  });

  await check("the DB itself refuses an UPDATE and a DELETE on consent_events (functional, not just source)", async () => {
    await assert.rejects(() =>
      db.execute({ sql: "UPDATE consent_events SET ticked = 0 WHERE tenant_id = ?", args: [TENANT_A] }),
    );
    await assert.rejects(() => db.execute({ sql: "DELETE FROM consent_events WHERE tenant_id = ?", args: [TENANT_A] }));
  });

  // ── 5. hasTickedConsent / marketingSendAllowed: no row refuses, latest row wins, read error refuses ──
  await check("hasTickedConsent: no row for this lead/channel refuses", async () => {
    const allowed = await hasTickedConsent(dbClient, { tenantId: TENANT_A, leadId: "lead-never-asked", channel: "email" });
    assert.equal(allowed, false);
  });

  await check("hasTickedConsent: a ticked row allows; marketingSendAllowed agrees", async () => {
    const allowed = await hasTickedConsent(dbClient, { tenantId: TENANT_A, leadId: LEAD_SHARED, channel: "email" });
    assert.equal(allowed, true);
    const verdict = await marketingSendAllowed(dbClient, { tenantId: TENANT_A, leadId: LEAD_SHARED, channel: "email" });
    assert.deepEqual(verdict, { allow: true });
  });

  await check("hasTickedConsent: sms was declined on the same submission; marketingSendAllowed refuses it", async () => {
    const allowed = await hasTickedConsent(dbClient, { tenantId: TENANT_A, leadId: LEAD_SHARED, channel: "sms" });
    assert.equal(allowed, false);
    const verdict = await marketingSendAllowed(dbClient, { tenantId: TENANT_A, leadId: LEAD_SHARED, channel: "sms" });
    assert.deepEqual(verdict, { allow: false, reason: "no_ticked_consent" });
  });

  await check("hasTickedConsent: the MOST RECENT row wins — a later decline overrides an earlier tick", async () => {
    await recordConsentEvents(dbClient, {
      tenantId: TENANT_A,
      leadId: "lead-flip-flop",
      formId: "form-2",
      decisions: [{ channel: "email", ticked: true }],
      identity,
      identitySource: "brand",
      ipAddress: "203.0.113.10",
      userAgent: null,
      pageUrl: null,
    });
    assert.equal(await hasTickedConsent(dbClient, { tenantId: TENANT_A, leadId: "lead-flip-flop", channel: "email" }), true);
    // created_at is second-resolution ISO; force the second row strictly later
    // so "most recent" is unambiguous regardless of how fast this runs.
    await new Promise((r) => setTimeout(r, 1100));
    await recordConsentEvents(dbClient, {
      tenantId: TENANT_A,
      leadId: "lead-flip-flop",
      formId: "form-2",
      decisions: [{ channel: "email", ticked: false }],
      identity,
      identitySource: "brand",
      ipAddress: "203.0.113.11",
      userAgent: null,
      pageUrl: null,
    });
    assert.equal(
      await hasTickedConsent(dbClient, { tenantId: TENANT_A, leadId: "lead-flip-flop", channel: "email" }),
      false,
      "a later decline must override an earlier tick",
    );
  });

  await check("hasTickedConsent: a read error refuses (fail closed), never throws, never defaults to allow", async () => {
    const throwingDb = {
      from() {
        return {
          select() {
            return this;
          },
          eq() {
            return this;
          },
          order() {
            return this;
          },
          limit() {
            return this;
          },
          async maybeSingle() {
            throw new Error("simulated connection failure");
          },
        };
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    const allowed = await hasTickedConsent(throwingDb, { tenantId: TENANT_A, leadId: LEAD_SHARED, channel: "email" });
    assert.equal(allowed, false);
    const verdict = await marketingSendAllowed(throwingDb, { tenantId: TENANT_A, leadId: LEAD_SHARED, channel: "email" });
    assert.deepEqual(verdict, { allow: false, reason: "no_ticked_consent" });
  });

  await check("hasTickedConsent: a query that answers an ERROR object (not a throw) also refuses", async () => {
    const erroringDb = {
      from() {
        return {
          select() {
            return this;
          },
          eq() {
            return this;
          },
          order() {
            return this;
          },
          limit() {
            return this;
          },
          async maybeSingle() {
            return { data: null, error: { message: "relation does not exist" } };
          },
        };
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    const allowed = await hasTickedConsent(erroringDb, { tenantId: TENANT_A, leadId: LEAD_SHARED, channel: "email" });
    assert.equal(allowed, false);
  });

  // ── 6. Workspace isolation ──
  await check("workspace isolation: the SAME lead id under a DIFFERENT tenant never sees tenant A's consent", async () => {
    // TENANT_B never recorded anything for LEAD_SHARED — only TENANT_A did,
    // above. A lead id is not globally unique across tenants by construction
    // of this test; the gate must still isolate correctly.
    const allowedB = await hasTickedConsent(dbClient, { tenantId: TENANT_B, leadId: LEAD_SHARED, channel: "email" });
    assert.equal(allowedB, false, "tenant B must not inherit tenant A's consent for the same lead id");
    const allowedA = await hasTickedConsent(dbClient, { tenantId: TENANT_A, leadId: LEAD_SHARED, channel: "email" });
    assert.equal(allowedA, true, "tenant A's own consent is unaffected by the isolation check");
  });

  // ── 7. Transactional sends are never gated ──
  await check("the ai-audit transactional welcome email does not import or call the consent gate", () => {
    const src = readFileSync(join(ROOT, "lib", "forms", "oasis-funnel-email.ts"), "utf8");
    assert.ok(!src.includes("consent/ledger"), "a transactional reply must never be refused for lack of a ticked marketing box");
    assert.ok(!src.includes("marketingSendAllowed"));
    assert.ok(!src.includes("hasTickedConsent"));
  });

  await check("the resume-link email (continuing the visitor's own in-progress form) does not call the consent gate", () => {
    const src = readFileSync(join(ROOT, "lib", "forms", "maybe-queue-resume.ts"), "utf8");
    assert.ok(!src.includes("consent/ledger"));
    assert.ok(!src.includes("marketingSendAllowed"));
  });

  finish("consent-ledger");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
