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
 *      as a default "yes"; each decision carries the normalised destination
 *      the step's OWN field held.
 *   3. recordConsentEvents: one row per rendered channel, the IP recorded
 *      is EXACTLY the caller's ipAddress argument (the submit route's only
 *      source for that argument is Cloudflare's header, never the body —
 *      pinned separately as a source check on the route), disclosure_hash
 *      is sha256 of the server's own rendered text, subject_hash binds the
 *      row to its destination. consentPageUrl never stores a signed token.
 *   4. No update or delete path: the migration's two triggers exist and
 *      abort any attempt; lib/consent/ledger.ts never chains .update(/
 *      .delete( off a consent_events access.
 *   5. hasTickedConsent / marketingSendAllowed: keyed on the DESTINATION,
 *      never the lead (consent for one number never authorises another on
 *      the same lead); no row refuses; a decline after a tick withdraws for
 *      good, on any lead record, and a later tick does not revive it; a
 *      blank-field row never authorises; a read error or an over-long
 *      history refuses (fail closed); the verdict carries the canonical
 *      address a sender must use.
 *   6. unrecordedWithdrawal: a failed decline that leaves an earlier tick
 *      standing (or cannot be checked) is reported, and the submit route
 *      refuses the submission on it, BEFORE the submission row is written.
 *   7. Workspace isolation: the same destination under two different
 *      tenants never sees the other tenant's consent.
 *   8. Transactional sends (the ai-audit welcome email) do not import or
 *      call the consent gate at all.
 *   9. The public page resets the boxes to unticked on every step change.
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
const EMAIL_A = "owner@client-a.test";
const PHONE_A = "+1 (514) 555-0101";

/** A fake client whose read answers with `answer` (or throws when it is an Error). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function readStub(answer: unknown): any {
  return {
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
        async limit() {
          if (answer instanceof Error) throw answer;
          return answer;
        },
      };
    },
  };
}

async function main() {
  const db = await setupDatabase();
  // consent_events is not part of the shared delivery harness — apply the
  // real migration file, statement by statement including its triggers.
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
    normalizeConsentSubject,
    CONSENT_DISCLOSURE_VERSION,
  } = await import("../lib/consent/ledger-disclosure");
  const {
    recordConsentEvents,
    hasTickedConsent,
    consentState,
    classifyConsentHistory,
    unrecordedWithdrawal,
    consentPageUrl,
    consentSubjectHash,
    sha256Hex,
  } = await import("../lib/consent/ledger");
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

  // ── 2. Channel derivation, forged-channel resistance, destination binding ──
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
    const decisions = consentDecisionsForStep(stepEmailOnly, { email: EMAIL_A }, { email: EMAIL_A }, { email: true, sms: true });
    assert.deepEqual(decisions, [{ channel: "email", ticked: true, subject: EMAIL_A }]);
    assert.ok(!decisions.some((d) => d.channel === "sms"), "a channel this step did not render must never be recorded");
  });

  await check("consentDecisionsForStep: an answer that is not exactly true is a decline, never a default yes", () => {
    assert.deepEqual(consentDecisionsForStep(stepBoth, {}, {}, { email: "yes", sms: false }), [
      { channel: "email", ticked: false, subject: null },
      { channel: "sms", ticked: false, subject: null },
    ]);
  });

  await check("consentDecisionsForStep: a box the page did not draw (no answer sent) is never recorded as shown-and-declined", () => {
    assert.deepEqual(consentDecisionsForStep(stepBoth, {}, {}, {}), []);
    assert.deepEqual(consentDecisionsForStep(stepBoth, {}, {}, { email: true }), [
      { channel: "email", ticked: true, subject: null },
    ]);
  });

  await check("consentDecisionsForStep: the destination comes from THIS submission, never from answers merged in from earlier ones", () => {
    const merged = { email: "earlier@client-a.test" };
    assert.deepEqual(consentDecisionsForStep(stepEmailOnly, merged, {}, { email: true }), [
      { channel: "email", ticked: true, subject: null },
    ]);
    assert.deepEqual(consentDecisionsForStep(stepEmailOnly, merged, { email: EMAIL_A }, { email: true }), [
      { channel: "email", ticked: true, subject: EMAIL_A },
    ]);
  });

  await check("consentDecisionsForStep: each decision carries the normalised destination the step's OWN field held", () => {
    const typed = { email: "  Owner@Client-A.TEST ", phone: PHONE_A };
    const decisions = consentDecisionsForStep(stepBoth, typed, typed, { email: true, sms: true });
    assert.deepEqual(decisions, [
      { channel: "email", ticked: true, subject: EMAIL_A },
      { channel: "sms", ticked: true, subject: "+15145550101" },
    ]);
  });

  await check("normalizeConsentSubject: one canonical form (lowercased mailbox, E.164), and anything ambiguous is null", () => {
    assert.equal(normalizeConsentSubject("email", " A@B.Test "), "a@b.test");
    assert.equal(normalizeConsentSubject("email", "not-an-email"), null);
    assert.equal(normalizeConsentSubject("sms", "+1 514-555-0101"), "+15145550101");
    assert.equal(normalizeConsentSubject("sms", "514.555.0101"), "+15145550101");
    assert.equal(normalizeConsentSubject("sms", "1 (514) 555-0101"), "+15145550101");
    assert.equal(normalizeConsentSubject("sms", "+44 20 7946 0958"), "+442079460958");
    assert.equal(normalizeConsentSubject("sms", "12"), null);
    assert.equal(normalizeConsentSubject("sms", 5145550101), null);
  });

  await check("normalizeConsentSubject: an input a mail or SMS library could read as a different or second recipient is refused", () => {
    assert.equal(normalizeConsentSubject("email", "a@b.test, victim@c.test"), null);
    assert.equal(normalizeConsentSubject("email", "a@b.test;victim@c.test"), null);
    assert.equal(normalizeConsentSubject("email", "Name <victim@c.test>"), null);
    assert.equal(normalizeConsentSubject("email", "a@b@c.test"), null);
    assert.equal(normalizeConsentSubject("email", "a @b.test"), null);
    assert.equal(normalizeConsentSubject("email", '"x"@b.test'), null);
    assert.equal(normalizeConsentSubject("sms", "514-555-0101 ext 22"), null);
    assert.equal(normalizeConsentSubject("sms", "514-555-0101,5145550199"), null);
    assert.equal(normalizeConsentSubject("sms", "23456789012"), null, "11 digits not starting with 1 and no + is ambiguous");
  });

  // ── 3. recordConsentEvents + page address ──
  const dbClient = getServiceSupabase();
  const identity = { businessName: "Test Co", address: "9 Test Ave", privacyUrl: "https://test.example/privacy" };

  await check("recordConsentEvents inserts one row per decision, with the server-rendered text, its own hash, the subject hash, and the caller's IP verbatim", async () => {
    const result = await recordConsentEvents(dbClient, {
      tenantId: TENANT_A,
      leadId: LEAD_SHARED,
      formId: "form-1",
      decisions: [
        { channel: "email", ticked: true, subject: EMAIL_A },
        { channel: "sms", ticked: false, subject: "+15145550101" },
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
      .select("channel, ticked, subject_hash, ip_address, user_agent, page_url, disclosure_text, disclosure_hash, disclosure_version")
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
      const expectSubject = channel === "email" ? EMAIL_A : "+15145550101";
      assert.equal(row.subject_hash, consentSubjectHash(channel, expectSubject));
      assert.ok(!String(row.subject_hash).includes(expectSubject), "the raw destination is never stored on the row");
      assert.equal(row.ticked, channel === "email" ? 1 : 0);
    }
  });

  await check("consentPageUrl: a signed form link never reaches the ledger; queries and fragments are dropped; junk falls back", () => {
    const origin = "https://oasisai.work";
    const signed = consentPageUrl(origin, "/f/oasis-ai-cc/ai-audit/eyJhbGciOi.SIGNED.TOKEN?x=1", "/f/oasis-ai-cc/ai-audit");
    assert.equal(signed, "https://oasisai.work/f/oasis-ai-cc/ai-audit/[signed-link]");
    assert.ok(!signed.includes("SIGNED"), "the signed token must not survive");
    assert.equal(
      consentPageUrl(origin, "/o/offer-page?t=secret#frag", "/f/a/b"),
      "https://oasisai.work/o/offer-page",
    );
    assert.equal(consentPageUrl(origin, "https://evil.test/x", "/f/a/b"), "https://oasisai.work/f/a/b");
    assert.equal(consentPageUrl(origin, "//evil.test/x", "/f/a/b"), "https://oasisai.work/f/a/b");
    assert.equal(consentPageUrl(origin, undefined, "/f/a/b"), "https://oasisai.work/f/a/b");
  });

  // ── 3b. Source pins on the submit route ──
  const routeSrc = readFileSync(join(ROOT, "app", "api", "forms", "submit", "route.ts"), "utf8");

  await check("the submit route's consent-ledger call passes the header-derived IP and a token-free page address", () => {
    const anchor = routeSrc.indexOf("recordConsentEvents(db, {");
    assert.ok(anchor >= 0, "recordConsentEvents call not found in the submit route");
    const block = routeSrc.slice(anchor, anchor + 500);
    assert.ok(/ipAddress:\s*ipHeader\b/.test(block), `expected ipAddress: ipHeader in:\n${block}`);
    assert.ok(!/body\.ip\b|body\["ip"\]|body\.ip_address/.test(block), "the ledger write must never read an IP off the request body");
    assert.ok(/pageUrl:\s*consentPageUrl\(/.test(block), "page_url must go through consentPageUrl, never the raw submission_path");
    assert.ok(/consentDecisionsForStep\(\s*currentStep,\s*mergedAnswers,\s*payload,/.test(routeSrc),
      "the destination must come from this submission's own payload; merged answers only decide visibility");
    assert.ok(/const resolvedIp = getClientIp\(req\);/.test(routeSrc));
    assert.ok(/const ipHeader = resolvedIp === "unknown" \? null : resolvedIp;/.test(routeSrc));
  });

  await check("the submit route records consent BEFORE the submission row, refuses 503 on an unrecorded withdrawal, and never logs a destination", () => {
    const ledgerAt = routeSrc.indexOf("recordConsentEvents(db, {");
    const insertAt = routeSrc.indexOf('.from("form_submissions")\n    .insert(');
    const insertAtCrlf = routeSrc.indexOf('.from("form_submissions")\r\n    .insert(');
    const submissionInsert = insertAt >= 0 ? insertAt : insertAtCrlf;
    assert.ok(submissionInsert > 0, "form_submissions insert not found");
    assert.ok(ledgerAt < submissionInsert, "the consent ledger must run before the submission row is written");
    const block = routeSrc.slice(ledgerAt, ledgerAt + 1400);
    assert.ok(/unrecordedWithdrawal\(db, form\.tenant_id, ledgerResult\)/.test(block));
    assert.ok(/consent_record_unavailable/.test(block) && /status: 503/.test(block));
    assert.ok(/failed: ledgerResult\.failed\.map\(\(f\) => \(\{ channel: f\.channel, ticked: f\.ticked \}\)\)/.test(block),
      "the failure log must carry channel and tick only, never the visitor's email/number");
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
    const re = /\.from\(\s*["']consent_events["']\s*\)([^;]{0,160})/g;
    let m: RegExpExecArray | null;
    let found = 0;
    while ((m = re.exec(src))) {
      found += 1;
      assert.ok(!/\.update\(|\.delete\(/.test(m[1]), `consent_events access followed by a mutation: ${m[1].slice(0, 80)}`);
    }
    assert.ok(found >= 2, "expected at least the insert (recordConsentEvents) and select (latestConsentState) accesses");
  });

  await check("the DB itself refuses an UPDATE and a DELETE on consent_events (functional, not just source)", async () => {
    await assert.rejects(() =>
      db.execute({ sql: "UPDATE consent_events SET ticked = 0 WHERE tenant_id = ?", args: [TENANT_A] }),
    );
    await assert.rejects(() => db.execute({ sql: "DELETE FROM consent_events WHERE tenant_id = ?", args: [TENANT_A] }));
  });

  // ── 5. The gate: destination-keyed, latest wins, fail closed ──
  await check("hasTickedConsent: a destination never asked refuses", async () => {
    assert.equal(await hasTickedConsent(dbClient, { tenantId: TENANT_A, channel: "email", destination: "never@asked.test" }), false);
  });

  await check("hasTickedConsent: a ticked destination allows, matched after normalisation; marketingSendAllowed agrees", async () => {
    assert.equal(await hasTickedConsent(dbClient, { tenantId: TENANT_A, channel: "email", destination: " OWNER@client-a.test" }), true);
    assert.deepEqual(
      await marketingSendAllowed(dbClient, { tenantId: TENANT_A, channel: "email", destination: " Owner@Client-A.test" }),
      { allow: true, destination: EMAIL_A },
      "the verdict hands back the canonical address, the only one a sender may use",
    );
  });

  await check("hasTickedConsent: sms was declined on the same submission; marketingSendAllowed refuses it", async () => {
    assert.equal(await hasTickedConsent(dbClient, { tenantId: TENANT_A, channel: "sms", destination: PHONE_A }), false);
    assert.deepEqual(
      await marketingSendAllowed(dbClient, { tenantId: TENANT_A, channel: "sms", destination: PHONE_A }),
      { allow: false, reason: "no_ticked_consent" },
    );
  });

  await check("consent for one number on a lead never authorises a DIFFERENT number on that same lead", async () => {
    // The forgery shape: an anonymous visitor merged into an existing lead
    // (smart-match by business name) ticks SMS for THEIR number. The lead's
    // real number must stay refused.
    await recordConsentEvents(dbClient, {
      tenantId: TENANT_A,
      leadId: "lead-merged",
      formId: "form-3",
      decisions: [{ channel: "sms", ticked: true, subject: "+14385550199" }],
      identity,
      identitySource: "brand",
      ipAddress: "198.51.100.7",
      userAgent: null,
      pageUrl: null,
    });
    assert.equal(await hasTickedConsent(dbClient, { tenantId: TENANT_A, channel: "sms", destination: "4385550199" }), true);
    assert.equal(
      await hasTickedConsent(dbClient, { tenantId: TENANT_A, channel: "sms", destination: "5145550177" }),
      false,
      "the stranger's tick must not reach the real customer's number",
    );
  });

  await check("a decline after a tick withdraws consent, even when it was recorded on a different lead record", async () => {
    await recordConsentEvents(dbClient, {
      tenantId: TENANT_A,
      leadId: "lead-flip-1",
      formId: "form-2",
      decisions: [{ channel: "email", ticked: true, subject: "flip@client-a.test" }],
      identity,
      identitySource: "brand",
      ipAddress: "203.0.113.10",
      userAgent: null,
      pageUrl: null,
    });
    assert.equal(await hasTickedConsent(dbClient, { tenantId: TENANT_A, channel: "email", destination: "flip@client-a.test" }), true);
    await new Promise((r) => setTimeout(r, 20));
    await recordConsentEvents(dbClient, {
      tenantId: TENANT_A,
      leadId: "lead-flip-2-duplicate",
      formId: "form-2",
      decisions: [{ channel: "email", ticked: false, subject: "flip@client-a.test" }],
      identity,
      identitySource: "brand",
      ipAddress: "203.0.113.11",
      userAgent: null,
      pageUrl: null,
    });
    assert.equal(
      await hasTickedConsent(dbClient, { tenantId: TENANT_A, channel: "email", destination: "flip@client-a.test" }),
      false,
      "a later decline must override an earlier tick, whichever lead record it landed on",
    );
    assert.equal(await consentState(dbClient, { tenantId: TENANT_A, channel: "email", destination: "flip@client-a.test" }), "withdrawn");
  });

  await check("a tick AFTER a withdrawal does not revive it (a stranger cannot undo someone's opt-out by typing their address)", async () => {
    await new Promise((r) => setTimeout(r, 20));
    await recordConsentEvents(dbClient, {
      tenantId: TENANT_A,
      leadId: "lead-stranger",
      formId: "form-2",
      decisions: [{ channel: "email", ticked: true, subject: "flip@client-a.test" }],
      identity,
      identitySource: "brand",
      ipAddress: "192.0.2.66",
      userAgent: null,
      pageUrl: null,
    });
    assert.equal(await hasTickedConsent(dbClient, { tenantId: TENANT_A, channel: "email", destination: "flip@client-a.test" }), false);
    assert.equal(await consentState(dbClient, { tenantId: TENANT_A, channel: "email", destination: "flip@client-a.test" }), "withdrawn");
  });

  await check("classifyConsentHistory: declines before the first tick never block it; any decline after it withdraws for good", () => {
    assert.equal(classifyConsentHistory([]), "none");
    assert.equal(classifyConsentHistory([{ ticked: 0 }, { ticked: 0 }]), "declined");
    assert.equal(classifyConsentHistory([{ ticked: 0 }, { ticked: 1 }]), "ticked");
    assert.equal(classifyConsentHistory([{ ticked: 1 }, { ticked: 1 }]), "ticked");
    assert.equal(classifyConsentHistory([{ ticked: 1 }, { ticked: 0 }]), "withdrawn");
    assert.equal(classifyConsentHistory([{ ticked: 1 }, { ticked: 0 }, { ticked: 1 }]), "withdrawn");
  });

  await check("a history longer than the read cap answers unknown, never a guess from part of it", async () => {
    const rows = Array.from({ length: 500 }, () => ({ ticked: 1 }));
    const longDb = readStub({ data: rows, error: null });
    assert.equal(await consentState(longDb, { tenantId: TENANT_A, channel: "email", destination: EMAIL_A }), "unknown");
    assert.equal(await hasTickedConsent(longDb, { tenantId: TENANT_A, channel: "email", destination: EMAIL_A }), false);
  });

  await check("an exact created_at tie between a tick and a decline reads as a withdrawal", async () => {
    const at = "2026-10-11T12:00:00.000Z";
    const hash = consentSubjectHash("email", "tie@client-a.test");
    for (const [id, ticked] of [["tie-1", 1], ["tie-2", 0]] as const) {
      await db.execute({
        sql: `INSERT INTO consent_events (id, tenant_id, lead_id, form_id, channel, ticked, subject_hash,
              disclosure_hash, disclosure_version, disclosure_text, identity_source, created_at)
              VALUES (?, ?, 'lead-tie', 'form-tie', 'email', ?, ?, 'h', 'v', 't', 'brand', ?)`,
        args: [id, TENANT_A, ticked, hash, at],
      });
    }
    assert.equal(await consentState(dbClient, { tenantId: TENANT_A, channel: "email", destination: "tie@client-a.test" }), "withdrawn");
  });

  await check("a tick recorded with a blank field (null subject) never authorises anything", async () => {
    await recordConsentEvents(dbClient, {
      tenantId: TENANT_A,
      leadId: "lead-blank",
      formId: "form-4",
      decisions: [{ channel: "sms", ticked: true, subject: null }],
      identity,
      identitySource: "brand",
      ipAddress: null,
      userAgent: null,
      pageUrl: null,
    });
    assert.equal(await hasTickedConsent(dbClient, { tenantId: TENANT_A, channel: "sms", destination: "" }), false);
    assert.equal(await hasTickedConsent(dbClient, { tenantId: TENANT_A, channel: "sms", destination: null }), false);
  });

  await check("hasTickedConsent: a read that throws refuses (fail closed), never throws, never defaults to allow", async () => {
    const throwingDb = readStub(new Error("simulated connection failure"));
    assert.equal(await hasTickedConsent(throwingDb, { tenantId: TENANT_A, channel: "email", destination: EMAIL_A }), false);
    assert.equal(await consentState(throwingDb, { tenantId: TENANT_A, channel: "email", destination: EMAIL_A }), "unknown");
    assert.deepEqual(
      await marketingSendAllowed(throwingDb, { tenantId: TENANT_A, channel: "email", destination: EMAIL_A }),
      { allow: false, reason: "no_ticked_consent" },
    );
  });

  await check("hasTickedConsent: a query that answers an ERROR object (not a throw) also refuses", async () => {
    const erroringDb = readStub({ data: null, error: { message: "relation does not exist" } });
    assert.equal(await hasTickedConsent(erroringDb, { tenantId: TENANT_A, channel: "email", destination: EMAIL_A }), false);
    assert.equal(await consentState(erroringDb, { tenantId: TENANT_A, channel: "email", destination: EMAIL_A }), "unknown");
  });

  // ── 6. A failed withdrawal is never silently lost ──
  const failedDecline = (subject: string | null) => ({
    ok: false,
    recorded: [],
    failed: [{ channel: "email" as const, ticked: false, subject, reason: "simulated write failure" }],
  });

  await check("unrecordedWithdrawal: a failed decline for a destination whose latest answer is still a tick is reported", async () => {
    // EMAIL_A was ticked in section 3 and nothing since has declined it.
    assert.equal(await unrecordedWithdrawal(dbClient, TENANT_A, failedDecline(EMAIL_A)), true);
  });

  await check("unrecordedWithdrawal: a failed decline with no earlier tick, or with a blank field, is not", async () => {
    assert.equal(await unrecordedWithdrawal(dbClient, TENANT_A, failedDecline("first-time@client-a.test")), false);
    assert.equal(await unrecordedWithdrawal(dbClient, TENANT_A, failedDecline(null)), false);
  });

  await check("unrecordedWithdrawal: a failed TICK is never a withdrawal", async () => {
    const failedTick = {
      ok: false,
      recorded: [],
      failed: [{ channel: "email" as const, ticked: true, subject: EMAIL_A, reason: "simulated write failure" }],
    };
    assert.equal(await unrecordedWithdrawal(dbClient, TENANT_A, failedTick), false);
  });

  await check("unrecordedWithdrawal: when the earlier answer cannot be read, it assumes the worst and reports", async () => {
    const throwingDb = readStub(new Error("simulated connection failure"));
    assert.equal(await unrecordedWithdrawal(throwingDb, TENANT_A, failedDecline(EMAIL_A)), true);
  });

  // ── 7. Workspace isolation ──
  await check("workspace isolation: the SAME destination under a DIFFERENT tenant never sees tenant A's consent", async () => {
    assert.equal(
      await hasTickedConsent(dbClient, { tenantId: TENANT_B, channel: "email", destination: EMAIL_A }),
      false,
      "tenant B must not inherit tenant A's consent for the same address",
    );
    assert.equal(await hasTickedConsent(dbClient, { tenantId: TENANT_A, channel: "email", destination: EMAIL_A }), true);
  });

  // ── 8. Transactional sends are never gated ──
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

  // ── 9. The public page never carries a tick across steps ──
  await check("FormPublicClient resets both boxes to unticked whenever the step changes", () => {
    const src = readFileSync(join(ROOT, "components", "forms", "FormPublicClient.tsx"), "utf8");
    assert.ok(/const \[ledgerStep, setLedgerStep\] = useState\(currentStep\);/.test(src));
    assert.ok(
      /if \(ledgerStep !== currentStep\) \{\s*setLedgerStep\(currentStep\);\s*setLedgerTicked\(\{ email: false, sms: false \}\);/.test(src),
      "a step change must reset both consent boxes",
    );
    assert.ok(/consent_record_unavailable:/.test(src), "the visitor sees plain words, not the 503 code");
  });

  await check("FormPublicClient sends the visitor's LAST answer, read after the address wait, never a stale tick", () => {
    const src = readFileSync(join(ROOT, "components", "forms", "FormPublicClient.tsx"), "utf8");
    assert.ok(
      /ledgerRef\.current = \{ channels: ledgerChannels, ticked: ledgerTicked \};/.test(src),
      "the ref must be re-pointed on every render",
    );
    const at = src.indexOf("submitBody.consent_ledger = {");
    assert.ok(at > 0, "consent_ledger body not found");
    const block = src.slice(Math.max(0, at - 400), at + 300);
    assert.ok(/const ledgerNow = ledgerRef\.current;/.test(block), "submit must read the boxes through the ref");
    assert.ok(!/ledgerTicked\.(email|sms)/.test(block), "submit must not read the closure's tick state");
    // Read AFTER every wait: the vault capture can take seconds with the boxes
    // still clickable, so the answer is taken immediately before the request.
    const vaultAt = src.indexOf("await captureConsent(");
    const fetchAt = src.indexOf('await fetch("/api/forms/submit", {', at);
    assert.ok(vaultAt > 0 && at > vaultAt, "the consent answer must be read after the vault capture");
    assert.ok(fetchAt > at && fetchAt - at < 400, "the consent answer must be read immediately before the submit request");
  });

  await check("support forms draw no consent boxes (their submissions go to the ticket desk, which never records them)", () => {
    const client = readFileSync(join(ROOT, "components", "forms", "FormPublicClient.tsx"), "utf8");
    assert.ok(
      /consentLedgerEnabled \? renderedChannelsForStep\(step, mergedValues\) : \[\]/.test(client),
      "a disabled ledger must draw no boxes",
    );
    const page = readFileSync(join(ROOT, "app", "f", "[tenant_slug]", "[form_slug]", "page.tsx"), "utf8");
    assert.ok(/const consentLedgerEnabled = result\.form\.slug\.trim\(\)\.toLowerCase\(\) !== SUPPORT_FORM_SLUG;/.test(page));
    assert.ok(/consentLedgerEnabled=\{consentLedgerEnabled\}/.test(page), "the plain form must receive it");
    assert.ok(/^\s+consentLedgerEnabled,$/m.test(page), "the offer page's embedded form must receive it");
    const support = readFileSync(join(ROOT, "lib", "delivery", "support-form.ts"), "utf8");
    assert.ok(/export const SUPPORT_FORM_SLUG = "support";/.test(support), "the slug the route routes on");
  });

  finish("consent-ledger");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
