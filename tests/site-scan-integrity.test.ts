/**
 * tests/site-scan-integrity.test.ts — the free scan's integrity rules (CodeRabbit review of PR #811):
 * a fix is worth what it moves on the displayed scale; missing evidence is never a zero; a failed or
 * orphaned scan can be retried the same day; a claim is reserved before anything is opened and only
 * the browser that ran the scan holds its claim key; a runner past its lease cannot write the
 * report; expired scans are purged. Local libSQL file, no network.
 *
 * Run: node --conditions=react-server --import tsx tests/site-scan-integrity.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { scoreFacts } from "../lib/site-scan/score";
import { baseNarrative } from "../lib/site-scan/narrative";
import { claimKeyFor } from "../lib/site-scan/claim";
import { formLinkMacMatches } from "../lib/form-links";
import { queueEnrichment } from "../lib/site-scan/run";
import {
  enrichStatement,
  findReusableScan,
  getScan,
  insertScan,
  purgeExpiredScans,
  reserveClaim,
  saveTier0,
  scanKeyOf,
  setClaimEngagement,
  setStatus,
  STALE_READ_MS,
} from "../lib/site-scan/store";
import { ENRICH_SCHEMA, FACTS_SCHEMA, SCORE_SCHEMA, type ScanFacts, type SiteSignals } from "../lib/site-scan/types";
import type { CheckKey, CheckStatus, SiteCheck } from "../lib/ai-audit/site-checks";

const ROOT = join(__dirname, "..");
const TENANT = "ef8d389e-3f15-43f2-ae00-3660f69a1452";

function check(key: CheckKey, status: CheckStatus): SiteCheck {
  return { key, status, detail: `${key} ${status}`, found: [], evidence: null };
}

const signals: SiteSignals = {
  title: "Acme", meta_description: null, h1: ["Acme"], og_site_name: null, language: "en", business_name: "Acme", tagline: null,
  phones: ["514 555 0100"], emails: [], localities: ["Laval"], services: [], pricing_mentioned: false, booking_tools: [], forms_count: 0,
  chat_tools: [], analytics: [], socials: {}, schema_types: [], copyright_year: 2026, blog: { found: false, latest_date: null },
  images_total: 0, images_missing_alt: 0, internal_links: 3, external_links: 0, cta_phrases: ["call us"], keywords: [], word_count: 100, text_excerpt: "",
};

function facts(over: Partial<ScanFacts>, checks: SiteCheck[]): ScanFacts {
  return {
    schema: FACTS_SCHEMA, domain: "acme.example", start_url: "https://acme.example/", final_url: "https://acme.example/", read_at: "2026-11-12T00:00:00.000Z",
    site: { unread: null, pages_read: 2, notes: [], https_served: true, response_ms: 400, html_kb: 30 }, checks, pagespeed: null, signals, ...over,
  };
}

function scoring() {
  // CodeRabbit's case: booking unknown, call link and CTA present, form and chat absent. Conversion
  // reads 40 of 70 readable points = 57; adding the form makes it 60/70 = 86, worth 29 x 30% = 9.
  const s = scoreFacts(facts({}, [check("click_to_call", "yes"), check("contact_form", "no"), check("online_booking", "unknown"), check("live_chat", "no")]));
  const conversion = s.pillars.find((p) => p.key === "conversion")!;
  assert.equal(conversion.score, 57);
  // 20 points over 70 readable, at 30% weight: 20 x 30 / 70 = 8.6, shown as 9 (was 6 on the raw scale).
  assert.equal(s.fixes.find((f) => f.key === "contact_form")?.impact, 9, "a fix is worth the move on the displayed scale");

  // An unread site has no score at all, not 0/100, and the narrative says so.
  const unread = facts({ site: { unread: "no_answer", pages_read: 0, notes: [], https_served: false, response_ms: null, html_kb: null }, signals: null }, []);
  const u = scoreFacts(unread);
  assert.equal(u.total, null, "missing evidence is not a zero");
  assert.ok(u.pillars.every((p) => p.score === null));
  assert.equal(u.fixes.length, 0, "no fix is recommended without evidence");
  assert.match(baseNarrative(unread, u).fixes_intro, /no OASIS score is given/);

  // With no pages read, an unknown chat check and unknown title checks recommend nothing.
  const thin = scoreFacts(facts({ signals: null }, [check("live_chat", "unknown"), check("title", "unknown"), check("meta_description", "yes"), check("https", "yes"), check("click_to_call", "yes"), check("contact_form", "yes"), check("online_booking", "yes")]));
  assert.ok(!thin.fixes.some((f) => f.key === "chat"), "an unknown chat check is not 'no chat'");
  assert.ok(!thin.fixes.some((f) => f.key === "seo_basics"), "an unknown title is not a missing title");
  // A known "no" still counts.
  const known = scoreFacts(facts({ signals: null }, [check("title", "no"), check("meta_description", "yes")]));
  assert.ok(known.fixes.some((f) => f.key === "seo_basics") || known.pillars.find((p) => p.key === "findability")!.detail.includes("Page title"));

  // A page with no readable text (a browser-drawn shell: mrrooter.ca read 586 KB and zero words,
  // 2026-11-12) is not evidence that a call link or a city is missing, and gets no total.
  const shell = scoreFacts(facts({ signals: { ...signals, word_count: 0, cta_phrases: [], phones: [], localities: [] } }, [check("https", "yes"), check("analytics", "yes"), check("sitemap", "yes"), check("html_size", "yes"), check("response_time", "yes"), check("mobile_viewport", "yes"), check("meta_description", "yes")]));
  assert.equal(shell.total, null, "no total from speed and HTTPS alone");
  assert.equal(shell.pillars.find((p) => p.key === "conversion")!.score, null, "nothing a visitor does could be read");
  assert.ok(!shell.fixes.some((f) => f.key === "cta" || f.key === "chat" || f.key === "locality"), "no fix is sold on a page nobody could read");

  // Without Google's phone test the speed pillar says so, whether it is full marks or has a missing item.
  const slow = scoreFacts(facts({ site: { unread: null, pages_read: 2, notes: [], https_served: true, response_ms: 2_000, html_kb: 30 } }, [check("html_size", "yes"), check("response_time", "no")]));
  const slowSpeed = slow.pillars.find((p) => p.key === "speed")!;
  assert.match(slowSpeed.detail, /^Missing: /);
  assert.match(slowSpeed.detail, /phone test was not available/);
  assert.match(scoreFacts(facts({}, [check("html_size", "yes"), check("response_time", "yes")])).pillars.find((p) => p.key === "speed")!.detail, /phone test was not available/);

  // A fully read site keeps the old arithmetic: every pillar scored, total over 100 weight.
  const read = scoreFacts(facts({}, [check("https", "yes"), check("click_to_call", "yes"), check("contact_form", "yes"), check("online_booking", "yes"), check("live_chat", "yes"), check("title", "yes"), check("meta_description", "yes"), check("sitemap", "yes"), check("mobile_viewport", "yes"), check("html_size", "yes"), check("response_time", "yes"), check("structured_data", "yes"), check("social_links", "yes"), check("analytics", "yes"), check("email_link", "yes")]));
  assert.ok(read.pillars.every((p) => p.score !== null));
  assert.equal(typeof read.total, "number");

  // Shared site builders: one scan per business folder, not per builder host.
  assert.equal(scanKeyOf({ host: "www.Acme.example", pathPrefix: "/" }), "acme.example");
  assert.equal(scanKeyOf({ host: "acme.wixsite.com", pathPrefix: "/Acme" }), "acme.wixsite.com/acme");
  assert.notEqual(scanKeyOf({ host: "x.wixsite.com", pathPrefix: "/one" }), scanKeyOf({ host: "x.wixsite.com", pathPrefix: "/two" }));
}

async function store() {
  const dir = mkdtempSync(join(tmpdir(), "site-scan-int-"));
  const db = createClient({ url: `file:${join(dir, "t.db")}` });
  try {
    await db.executeMultiple(readFileSync(join(ROOT, "database", "turso", "bravo__206_tool_jobs.sql"), "utf8"));
    await db.executeMultiple(readFileSync(join(ROOT, "database", "turso", "bravo__259_site_scans.sql"), "utf8"));
    const t0 = new Date("2026-11-14T10:00:00.000Z"); // after REPORT_FORMAT_SINCE, as every new scan is

    // A failed scan is retried the same day: the row is reset in place and the caller must run it.
    const first = await insertScan(db, { tenantId: TENANT, domain: "fail.example", url: "https://fail.example/", ipHash: null, now: t0 });
    assert.equal(first.started, true);
    await setStatus(db, { tenantId: TENANT, id: first.row.id, status: "failed", stage: "read", errorCode: "read_failed", now: t0 });
    const retry = await insertScan(db, { tenantId: TENANT, domain: "fail.example", url: "https://fail.example/", ipHash: null, now: new Date(t0.getTime() + 60_000) });
    assert.equal(retry.row.id, first.row.id, "one row per domain per day");
    assert.equal(retry.started, true, "the retry owns the read");
    assert.equal(retry.row.status, "reading");
    assert.equal(retry.row.errorCode, null);
    // A live read is not restarted by a second visitor.
    const second = await insertScan(db, { tenantId: TENANT, domain: "fail.example", url: "https://fail.example/", ipHash: null, now: new Date(t0.getTime() + 90_000) });
    assert.equal(second.started, false);

    // An orphaned read (its Worker died) is not handed to the next visitor, and is restarted by them.
    const orphanAt = new Date(t0.getTime() + 61_000 + STALE_READ_MS);
    assert.equal(await findReusableScan(db, TENANT, "fail.example", orphanAt), null, "a read nobody touches is not reused");
    const restarted = await insertScan(db, { tenantId: TENANT, domain: "fail.example", url: "https://fail.example/", ipHash: null, now: orphanAt });
    assert.equal(restarted.started, true);

    // Claims: reserved before anything is opened; a second lead loses; the first lead's retry is "mine".
    const { row } = await insertScan(db, { tenantId: TENANT, domain: "claim.example", url: "https://claim.example/", ipHash: "h", now: t0 });
    const [a, b] = await Promise.all([
      reserveClaim(db, { tenantId: TENANT, id: row.id, leadRecordId: "lead-a", now: t0 }),
      reserveClaim(db, { tenantId: TENANT, id: row.id, leadRecordId: "lead-b", now: t0 }),
    ]);
    assert.deepEqual([a, b].sort(), ["reserved", "taken"], "exactly one lead wins the scan");
    const winner = a === "reserved" ? "lead-a" : "lead-b";
    assert.equal(await reserveClaim(db, { tenantId: TENANT, id: row.id, leadRecordId: winner, now: t0 }), "mine");
    assert.equal(await setClaimEngagement(db, { tenantId: TENANT, id: row.id, leadRecordId: winner === "lead-a" ? "lead-b" : "lead-a", engagementId: "eng-x", now: t0 }), false, "the loser cannot set the engagement");
    assert.equal(await setClaimEngagement(db, { tenantId: TENANT, id: row.id, leadRecordId: winner, engagementId: "eng-1", now: t0 }), true);
    assert.equal(await setClaimEngagement(db, { tenantId: TENANT, id: row.id, leadRecordId: winner, engagementId: "eng-2", now: t0 }), false, "set once");
    assert.equal((await getScan(db, TENANT, row.id))!.engagementId, "eng-1");

    // The claim key is bound to its scan: another scan's key does not open this one.
    const key = claimKeyFor(row.id);
    assert.ok(key);
    assert.equal(formLinkMacMatches("site_scan_claim/v1", row.id, key!), true);
    assert.equal(formLinkMacMatches("site_scan_claim/v1", row.id, claimKeyFor(first.row.id)!), false);
    assert.equal(formLinkMacMatches("site_scan_claim/v1", row.id, ""), false);

    // A runner past its lease cannot write the report; the current lease can.
    const { row: enr } = await insertScan(db, { tenantId: TENANT, domain: "lease.example", url: "https://lease.example/", ipHash: null, now: t0 });
    const f = facts({ domain: "lease.example" }, []);
    await saveTier0(db, { tenantId: TENANT, id: enr.id, facts: f, score: { schema: SCORE_SCHEMA, total: 50, pillars: [], fixes: [] }, narrative: baseNarrative(f, scoreFacts(f)), status: "enriching", stage: "profile", now: t0 });
    assert.deepEqual(await queueEnrichment(db, { tenantId: TENANT, scanId: enr.id, attempt: enr.createdAt, now: t0 }), { ok: true });
    const job = (await db.execute({ sql: "SELECT id FROM tool_jobs WHERE tenant_id = ? AND tool_key = 'site_scan_enrich' AND json_extract(input_json, '$.scan_id') = ?", args: [TENANT, enr.id] })).rows[0];
    const jobId = String(job.id);
    await db.execute({ sql: "UPDATE tool_jobs SET status = 'running', claimed_by = 'bea:runner-b', lease_id = 'lease-b' WHERE id = ?", args: [jobId] });
    const write = {
      tenantId: TENANT, id: enr.id, now: t0, embedding: null, narrative: null,
      enrich: { schema: ENRICH_SCHEMA, engine: { embedder: "hashed-tfidf:2048", version: "1" }, category: null, keywords: [], segments: [], competitors: [], prospects: [], email_auth: null, notes: [] },
    } as Parameters<typeof enrichStatement>[0];
    const stale = await db.execute(enrichStatement(write, { jobId, runnerKey: "bea:runner-a", leaseId: "lease-a" }));
    assert.equal(stale.rowsAffected, 0, "an expired lease writes nothing");
    assert.equal((await getScan(db, TENANT, enr.id))!.status, "enriching");
    const live = await db.execute(enrichStatement(write, { jobId, runnerKey: "bea:runner-b", leaseId: "lease-b" }));
    assert.equal(live.rowsAffected, 1);
    assert.equal((await getScan(db, TENANT, enr.id))!.status, "done");

    // Retention: past expires_at, unclaimed scans go; claimed ones stay without the address hash.
    const later = new Date(t0.getTime() + 31 * 86_400_000);
    const purged = await purgeExpiredScans(db, TENANT, later);
    assert.ok(purged.deleted >= 2, `unclaimed expired scans deleted: ${purged.deleted}`);
    assert.equal(purged.scrubbed, 1, "the claimed scan's address hash is cleared");
    const kept = (await db.execute({ sql: "SELECT ip_hash, lead_record_id FROM site_scans WHERE id = ?", args: [row.id] })).rows[0];
    assert.equal(kept.lead_record_id, winner);
    assert.equal(kept.ip_hash, null);
    assert.equal((await purgeExpiredScans(db, "other-tenant", later)).deleted, 0, "a purge stays in its workspace");
  } finally {
    db.close();
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      /* temp dir left behind on Windows */
    }
  }
}

async function main() {
  scoring();
  await store();
  console.log("site-scan-integrity: ok");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
