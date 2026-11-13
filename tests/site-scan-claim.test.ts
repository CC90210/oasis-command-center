/**
 * tests/site-scan-claim.test.ts — claiming a free scan, end to end on the delivery harness's local
 * database, with real signed form tokens: the claim key and the audit form are both required;
 * each claimant gets their own engagement with the scan attached (claims are not exclusive, and
 * nobody can take a report from someone else); a retry lands on the same engagement and writes
 * the attachment once; a lead with no audit possible is told so, never shown a success.
 *
 * Run: node --conditions=react-server --import tsx tests/site-scan-claim.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Client } from "@libsql/client";
import { OASIS, check, finish, setupDatabase } from "./_delivery-harness";

process.env.FORM_LINK_HMAC_KEY = "site-scan-claim-test-key-0123456789abcdef";

const AUDIT_FORM = "form-ai-audit";
const START_FORM = "form-start";
const LEAD_A = "lead-scan-a";
const LEAD_B = "lead-scan-b";
const LEAD_LOST = "lead-scan-lost";

async function apply(db: Client, file: string) {
  await db.executeMultiple(readFileSync(join(process.cwd(), "database", "turso", file), "utf8"));
}

async function seedLead(db: Client, id: string, stage: string) {
  await db.execute({
    sql: "INSERT INTO tenant_records (id, tenant_id, entity_type, data) VALUES (?, ?, 'lead', ?)",
    args: [id, OASIS, JSON.stringify({ stage, company: "[TEST] Scan Fixture Co", name: "Test Owner", email: `${id}@fixture.test`, website: "https://scan-fixture.test/" })],
  });
}

async function main() {
  const db = await setupDatabase();
  for (const f of ["bravo__206_tool_jobs.sql", "bravo__237_ai_audit_core.sql", "bravo__238_ai_audit_delivery.sql", "bravo__239_ai_audit_discovery.sql", "bravo__259_site_scans.sql"]) await apply(db, f);
  await db.execute({ sql: "INSERT INTO forms (id, tenant_id, slug, name) VALUES (?, ?, 'ai-audit', 'AI audit'), (?, ?, 'start', 'Start')", args: [AUDIT_FORM, OASIS, START_FORM, OASIS] });
  await seedLead(db, LEAD_A, "qualified");
  await seedLead(db, LEAD_B, "qualified");
  await seedLead(db, LEAD_LOST, "lost");

  const { signFormLink } = await import("../lib/form-links");
  const { claimKeyFor, claimScan } = await import("../lib/site-scan/claim");
  const { getScan, insertScan } = await import("../lib/site-scan/store");
  const now = new Date("2026-11-12T12:00:00.000Z");
  const { row } = await insertScan(db, { tenantId: OASIS, domain: "scan-fixture.test", url: "https://scan-fixture.test/", ipHash: null, now });
  const key = claimKeyFor(row.id)!;
  const token = (lead: string, form = AUDIT_FORM) => signFormLink({ tenant: "oasis-ai-cc", form_id: form, lead_id: lead })!;
  const claim = (lead: string, opts: { form?: string; claimKey?: string } = {}) =>
    claimScan(db, { tenantId: OASIS, scanId: row.id, token: token(lead, opts.form), claimKey: opts.claimKey ?? key, now });
  const attachments = async (engagementId: string) =>
    Number((await db.execute({ sql: "SELECT count(*) AS n FROM ai_audit_events WHERE engagement_id = ? AND event = 'free_scan_attached' AND ref_id = ?", args: [engagementId, row.id] })).rows[0].n);

  await check("the claim key and the audit form are both required", async () => {
    assert.deepEqual(await claim(LEAD_A, { claimKey: "not-the-key" }), { ok: false, error: "bad_claim_key" });
    assert.deepEqual(await claim(LEAD_A, { claimKey: claimKeyFor("00000000-0000-4000-8000-000000000000")! }), { ok: false, error: "bad_claim_key" }, "another scan's key");
    assert.deepEqual(await claim(LEAD_A, { form: START_FORM }), { ok: false, error: "wrong_form" }, "a token from the workspace's other form");
    const forged = await claimScan(db, { tenantId: OASIS, scanId: row.id, token: "v1.e30.", claimKey: key, now });
    assert.equal(forged.ok, false);
    assert.equal((await getScan(db, OASIS, row.id))!.leadRecordId, null, "nothing was reserved by a refused claim");
  });

  await check("a failed claimant arriving first leaves the scan unclaimed, and is told the audit did not open", async () => {
    assert.deepEqual(await claim(LEAD_LOST), { ok: false, error: "audit_not_opened" });
    const scan = (await getScan(db, OASIS, row.id))!;
    assert.equal(scan.leadRecordId, null, "no first claim recorded for an audit that never opened");
    assert.equal(scan.outcome, "none");
  });

  let engagementA = "";
  await check("the first claim opens an engagement, records the scan once, and marks the row", async () => {
    const a = await claim(LEAD_A);
    assert.ok(a.ok, JSON.stringify(a));
    engagementA = a.engagementId;
    assert.equal(a.alreadyClaimed, false);
    const scan = (await getScan(db, OASIS, row.id))!;
    assert.equal(scan.leadRecordId, LEAD_A);
    assert.equal(scan.engagementId, engagementA);
    assert.equal(scan.outcome, "claimed");
    assert.equal(await attachments(engagementA), 1);
  });

  await check("a retry, and two retries at once, land on the same engagement and write the attachment once", async () => {
    const again = await claim(LEAD_A);
    assert.ok(again.ok);
    assert.equal(again.engagementId, engagementA);
    assert.equal(again.alreadyClaimed, true);
    const both = await Promise.all([claim(LEAD_A), claim(LEAD_A)]);
    assert.ok(both.every((r) => r.ok && r.engagementId === engagementA));
    assert.equal(await attachments(engagementA), 1);
  });

  await check("a second lead on the same report gets its own engagement, and the first claim stands", async () => {
    const b = await claim(LEAD_B);
    assert.ok(b.ok, JSON.stringify(b));
    assert.notEqual(b.engagementId, engagementA, "never the other lead's engagement");
    assert.equal(await attachments(b.engagementId), 1, "the scan is attached to the second lead's audit too");
    const scan = (await getScan(db, OASIS, row.id))!;
    assert.equal(scan.leadRecordId, LEAD_A);
    assert.equal(scan.engagementId, engagementA);
  });

  // The free scan is its own offer (lib/site-scan/offer.ts): a claim submits the free-scan form, so
  // its lead is filed under the scan and never counted as an AI Automation Audit submission. The
  // audit intake's token still claims (the fallback while free-scan is off, and a browser that
  // loaded the page before the form existed).
  await check("the scan's own offer form claims; the page uses it only while it is switched on", async () => {
    const { scanClaimFormSlug } = await import("../lib/site-scan/claim");
    assert.equal(await scanClaimFormSlug(db, OASIS), "ai-audit", "no free-scan form yet: the audit intake");
    await db.execute({ sql: "INSERT INTO forms (id, tenant_id, slug, name, enabled) VALUES ('form-free-scan', ?, 'free-scan', 'Free AI website scan', 0)", args: [OASIS] });
    assert.equal(await scanClaimFormSlug(db, OASIS), "ai-audit", "switched off: the audit intake");
    await db.execute({ sql: "UPDATE forms SET enabled = 1 WHERE id = 'form-free-scan'" });
    assert.equal(await scanClaimFormSlug(db, OASIS), "free-scan", "switched on: the scan's own form");
    assert.equal(await scanClaimFormSlug(db, "another-workspace"), "ai-audit");
    await seedLead(db, "lead-scan-offer", "qualified");
    const viaScan = await claim("lead-scan-offer", { form: "form-free-scan" });
    assert.ok(viaScan.ok, JSON.stringify(viaScan));
    assert.equal(await attachments(viaScan.engagementId), 1, "a free-scan claim opens the audit with the scan attached");
    assert.deepEqual(await claim(LEAD_A, { form: START_FORM }), { ok: false, error: "wrong_form" }, "the workspace's other forms still cannot claim");
  });

  finish("site-scan-claim");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
