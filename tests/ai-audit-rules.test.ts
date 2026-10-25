/**
 * ai-audit-rules.test.ts — the Free AI Audit's pure rules, with no database.
 *
 * What a mistake here would cost: a figure with no source on a client's audit,
 * a price nobody confirmed, a payment request for the wrong amount, a link
 * that could be guessed or replayed, or a website-sales checkout whose request
 * to Stripe quietly changed. Each check below pins one of those.
 *
 * Run: node --conditions=react-server --import tsx tests/ai-audit-rules.test.ts
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
for (const k of ["DASHBOARD_LIVE_SEND", "LIVE_SEND_EMAIL", "LIVE_SEND_AI_AUDIT", "LIVE_SEND_STRIPE_CHECKOUT", "BRAVO_FORCE_DRY_RUN"]) delete process.env[k];

let failures = 0;
async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (e) {
    failures += 1;
    console.log(`  FAIL  ${name}\n        ${((e as Error).stack || String(e)).split("\n").slice(0, 6).join("\n        ")}`);
  }
}

function goodDoc() {
  return {
    schema: "ai_audit_doc/v1",
    business: { name: "[TEST] OASIS Audit Fixture Co", type: "local_service", location: "Collingwood, ON", website: "https://oasisai.work/fixtures/audit-fixture-co.html" },
    prepared_for: { name: "Test Owner" },
    prepared_on: "2026-10-25",
    sections: {
      executive_overview: { paragraphs: [{ text: "Leads that call after hours wait until the next day.", cites: [] }] },
      current_assessment: { paragraphs: [{ text: "The business books jobs by phone and email.", cites: [] }], systems: [{ name: "Gmail", role: "Inbox for quote requests", label: "client_reported", cites: ["s1"] }] },
      key_findings: { finding_ids: ["f1", "f2"] },
      inefficiencies: { items: [{ title: "Slow replies", why_it_matters: { text: "A late reply loses the job.", cites: ["f1"] }, consequence: { text: "Quotes go to a faster competitor.", cites: [] }, finding_ids: ["f1"] }] },
      opportunities: {
        items: [
          {
            id: "o1",
            title: "Instant reply to new leads",
            what_it_does: "Answers every new enquiry right away with a booking link.",
            problem: "Enquiries wait until the next morning.",
            how_it_works: "A form submission triggers a text and an email with available times.",
            integrations: ["Gmail", "Google Calendar"],
            expected_improvement: { text: "Saves about 5 to 8 hours a month of follow-up.", cites: ["e1"] },
            finding_ids: ["f1"],
            estimate_ids: ["e1"],
            workflow: { before: ["Form arrives", "Owner sees it next day"], after: ["Form arrives", "Instant reply with times"] },
          },
        ],
      },
      roadmap: { now: [{ opportunity_id: "o1", impact: "high", effort: "low", dependencies: [], urgency: "" }], next: [], later: [] },
      impact: { estimate_ids: ["e1"], limitations: ["Depends on how many leads arrive after hours."] },
      next_steps: { steps: ["Approve the proposal", "Kickoff call"] },
    },
    findings: [
      { id: "f1", title: "Replies take a day", statement: "The owner said most replies go out the next morning.", label: "client_reported", source_ids: ["s1"] },
      { id: "f2", title: "Calls may be missed", statement: "Calls during jobs may go to voicemail.", label: "hypothesis", source_ids: [], how_to_test: "Count voicemails for two weeks." },
    ],
    estimates: [
      {
        id: "e1",
        title: "Follow-up time saved",
        formula: "enquiries per month x minutes each",
        low: 5,
        high: 8,
        unit: "hours",
        period: "a month",
        inputs: [{ name: "Enquiries per month", value: 30, label: "client_reported", basis: "s1" }],
        assumptions: ["Ten to fifteen minutes per manual follow-up."],
      },
    ],
    sources: [{ id: "s1", kind: "client", title: "Discovery call, 2026-10-20" }],
    gaps: [{ topic: "Website traffic", why: "No analytics access was shared." }],
  };
}

async function main() {
  const rules = await import("../lib/ai-audit/rules");
  const doc = await import("../lib/ai-audit/doc");
  const proposal = await import("../lib/ai-audit/proposal");
  const catalogue = await import("../lib/ai-audit/catalogue");
  const payload = await import("../lib/ai-audit/delivery-payload");
  const link = await import("../lib/ai-audit/link");
  const canonical = await import("../lib/ai-audit/canonical");
  const hash = await import("../lib/ai-audit/hash");
  const sendMode = await import("../lib/integrations/send-mode");
  const payment = await import("../lib/website-sales-payment");
  const profile = await import("../lib/ai-audit/profile");

  console.log("stages");
  await check("the brief's 13 CRM stages, in order, plus declined and cancelled", () => {
    assert.deepEqual(rules.AI_AUDIT_STAGES.slice(0, 13).map((s) => rules.AI_AUDIT_STAGE_LABELS[s]), [
      "New Lead",
      "Research in Progress",
      "Discovery Call Scheduled",
      "Discovery Call Completed",
      "Transcript Awaiting Approval",
      "Research & Audit Generation",
      "Audit Awaiting Final Approval",
      "Audit Delivered",
      "Proposal Under Review",
      "Payment Pending",
      "Payment Confirmed",
      "Onboarding In Progress",
      "Active Client",
    ]);
    assert.equal(rules.stageNumber("active_client"), 13);
    assert.equal(rules.stageNumber("declined"), null);
  });
  await check("a paid engagement only moves on to onboarding; end states move nowhere", () => {
    assert.deepEqual([...rules.STAGE_MOVES.payment_confirmed], ["onboarding"]);
    assert.equal(rules.mayMoveStage("payment_confirmed", "delivered"), false);
    assert.equal(rules.mayMoveStage("delivered", "payment_confirmed"), true);
    assert.equal(rules.STAGE_MOVES.declined.length + rules.STAGE_MOVES.cancelled.length + rules.STAGE_MOVES.active_client.length, 0);
    for (const s of rules.MANUAL_STAGE_TARGETS) assert.ok(!["delivered", "payment_confirmed", "onboarding", "active_client"].includes(s), `${s} must never be set by hand`);
  });
  await check("every engagement stage maps to a real pipeline stage or none", () => {
    const pipeline = new Set(["researched", "assigned", "attempting_contact", "connected", "qualified", "founder_meeting_booked", "demo_completed", "proposal_sent", "won", "lost", "onboarding", "in_build", "client_review", "launched"]);
    for (const s of rules.AI_AUDIT_STAGES) {
      const t = rules.LEAD_STAGE_FOR[s];
      assert.ok(t === null || pipeline.has(t), `${s} maps to unknown ${t}`);
    }
    assert.equal(rules.LEAD_STAGE_FOR.payment_confirmed, "won");
    assert.equal(rules.LEAD_STAGE_FOR.delivered, "proposal_sent");
  });

  console.log("evidence rules");
  await check("a well-formed audit validates and meets every rule", () => {
    const v = doc.validateAuditDoc(goodDoc());
    assert.ok(v.ok, !v.ok ? `${v.path} ${v.message}` : "");
    assert.deepEqual(doc.blockingIssues(v.ok ? v.doc : (null as never)), []);
  });
  await check("a figure with no citation blocks submission; a bare year does not", () => {
    const d = goodDoc();
    d.sections.executive_overview.paragraphs = [{ text: "They lose 40% of leads.", cites: [] }];
    const v = doc.validateAuditDoc(d);
    assert.ok(v.ok);
    assert.ok(doc.blockingIssues(v.doc).some((i) => /figure without citing/.test(i.message)));
    assert.equal(doc.statesFigure("Founded in 2014 and still growing."), false);
    assert.equal(doc.statesFigure("About 12 calls a week."), true);
  });
  await check("Verified needs a source; Client-reported needs a client source", () => {
    const d = goodDoc();
    d.findings[0] = { ...d.findings[0], label: "verified", source_ids: [] };
    let v = doc.validateAuditDoc(d);
    assert.ok(v.ok && doc.blockingIssues(v.doc).some((i) => /Verified fact with no source/.test(i.message)));
    const e = goodDoc();
    e.sources.push({ id: "s2", kind: "website", title: "Homepage", url: "https://example.com", retrieved_at: "2026-10-24" } as never);
    e.findings[0] = { ...e.findings[0], source_ids: ["s2"] };
    v = doc.validateAuditDoc(e);
    assert.ok(v.ok && doc.blockingIssues(v.doc).some((i) => /does not name where the client said it/.test(i.message)));
  });
  await check("a Hypothesis carries no figure and must say how to test it", () => {
    const d = goodDoc();
    d.findings[1] = { ...d.findings[1], statement: "About 30% of calls are missed.", how_to_test: undefined } as never;
    const v = doc.validateAuditDoc(d);
    assert.ok(v.ok);
    const msgs = doc.blockingIssues(v.doc).map((i) => i.message).join(" | ");
    assert.match(msgs, /Hypothesis but its statement contains a figure/);
    assert.match(msgs, /must say how it could be tested/);
  });
  await check("an estimate needs inputs, assumptions and a sane range", () => {
    const d = goodDoc();
    d.estimates[0] = { ...d.estimates[0], low: 9, high: 3, inputs: [], assumptions: [] };
    const v = doc.validateAuditDoc(d);
    assert.ok(v.ok);
    const msgs = doc.blockingIssues(v.doc).map((i) => i.message).join(" | ");
    assert.match(msgs, /low end above its high end/);
    assert.match(msgs, /shows no inputs/);
    assert.match(msgs, /states no assumptions/);
  });
  await check("references to ids that do not exist are caught everywhere", () => {
    const d = goodDoc();
    d.sections.roadmap.now[0].opportunity_id = "o9";
    d.sections.key_findings.finding_ids.push("f9");
    d.sections.opportunities.items[0].estimate_ids.push("e9");
    const v = doc.validateAuditDoc(d);
    assert.ok(v.ok);
    const msgs = doc.blockingIssues(v.doc).map((i) => i.message).join(" | ");
    assert.match(msgs, /opportunity "o9"/);
    assert.match(msgs, /finding "f9"/);
    assert.match(msgs, /estimate "e9"/);
  });
  await check("structure: duplicate ids and a wrong schema are refused", () => {
    const d = goodDoc();
    d.sources.push({ id: "f1", kind: "client", title: "dup" } as never);
    const v = doc.validateAuditDoc(d);
    assert.ok(!v.ok && /used twice/.test(v.message));
    assert.ok(!doc.validateAuditDoc({ ...goodDoc(), schema: "v0" }).ok);
  });

  console.log("proposal");
  const baseProposal = () => ({
    schema: "ai_audit_proposal/v1" as const,
    currency: "CAD" as const,
    lines: [
      { kind: "owner_set" as const, line_id: "l1", name: "Build", description: "", category: "implementation" as const, unit: "fixed" as const, quantity: 1, optional: false, unit_price_cents: 250_000, set_by: "u", set_at: "t", deliverables: [], onboarding_requirements: [] },
      { kind: "owner_set" as const, line_id: "l2", name: "Care plan", description: "", category: "monthly" as const, unit: "per_month" as const, quantity: 1, optional: false, unit_price_cents: 20_000, set_by: "u", set_at: "t", deliverables: [], onboarding_requirements: [] },
      { kind: "owner_set" as const, line_id: "l3", name: "Extra", description: "", category: "add_on" as const, unit: "fixed" as const, quantity: 2, optional: true, unit_price_cents: 10_000, set_by: "u", set_at: "t", deliverables: [], onboarding_requirements: [] },
    ],
    phases: [],
    payment_terms: { kind: "deposit" as const, deposit_bps: 5_000, balance_due: "at launch" },
    tax: { mode: "registered" as const, rate_bps: 1_300, label: "HST" },
    exclusions: [],
    terms: [],
    valid_until: "2099-01-01",
    delivery_email: { to: "owner@fixture.test", subject: "Your audit", body: "Here it is: {{audit_link}}" },
  });
  await check("totals: tax on the one-time work, deposit of the total, monthly and optional apart", () => {
    const t = proposal.proposalTotals(baseProposal());
    assert.deepEqual(t, { subtotal_cents: 250_000, tax_cents: 32_500, total_cents: 282_500, due_now_cents: 141_250, monthly_cents: 20_000, optional_cents: 20_000 });
  });
  await check("blockers: an unpriced line, no tax rule, a missing link placeholder, an expired offer", () => {
    const p = baseProposal() as unknown as Parameters<typeof proposal.proposalBlockers>[0];
    p.lines.push({ kind: "needs_owner_price", line_id: "l4", name: "Custom", description: "", category: "implementation", unit: "fixed", quantity: 1, optional: false, deliverables: [], onboarding_requirements: [] });
    p.tax = null;
    p.delivery_email.body = "no link";
    p.valid_until = "2020-01-01";
    const b = proposal.proposalBlockers(p, "2026-10-25").join(" | ");
    assert.match(b, /needs your price/);
    assert.match(b, /tax rule/);
    assert.match(b, /\{\{audit_link\}\} exactly once/);
    assert.match(b, /valid-until date has passed/);
    assert.deepEqual(proposal.proposalBlockers(baseProposal(), "2026-10-25"), []);
  });
  await check("a catalogue line in another currency is refused", () => {
    const p = baseProposal() as unknown as Parameters<typeof proposal.proposalBlockers>[0];
    p.lines.push({ kind: "catalogue", line_id: "l5", sku: "x", item_id: "i", item_version: 1, name: "USD item", description: "", category: "implementation", unit: "fixed", quantity: 1, optional: false, unit_price_cents: 100, currency: "USD", deliverables: [], onboarding_requirements: [] });
    assert.match(proposal.proposalBlockers(p, "2026-10-25").join(" "), /priced in USD, not CAD/);
  });

  console.log("catalogue");
  await check("every seed item cites a real file, and the cited line holds its price", () => {
    for (const item of catalogue.CATALOGUE_SEED) {
      const file = join(ROOT, item.source_ref.file);
      assert.ok(existsSync(file), `${item.sku}: ${item.source_ref.file} does not exist`);
      if (!item.source_ref.line || item.price_cents === null) continue;
      const line = readFileSync(file, "utf8").split("\n")[item.source_ref.line - 1] ?? "";
      const dollars = item.price_cents / 100;
      const forms = [String(dollars), dollars.toLocaleString("en-US"), `${dollars.toLocaleString("en-US").replace(/,/g, "_")}`, String(item.price_cents).replace(/(\d)(?=(\d{3})+$)/g, "$1_"), `${dollars}_00`, `${(dollars / 1000).toLocaleString("en-US")}_000`];
      assert.ok(forms.some((f) => line.includes(f)), `${item.sku}: line ${item.source_ref.line} of ${item.source_ref.file} does not show ${dollars}: ${line.trim()}`);
    }
  });
  await check("drafts: sku shape, monthly unit rule, a per-unit item names its unit", () => {
    assert.ok(!catalogue.validateCatalogueDraft({ sku: "Bad SKU", name: "x", category: "implementation", unit: "fixed", currency: "CAD" }).ok);
    assert.ok(!catalogue.validateCatalogueDraft({ sku: "care", name: "x", category: "monthly", unit: "fixed", currency: "CAD" }).ok);
    assert.ok(!catalogue.validateCatalogueDraft({ sku: "integ", name: "x", category: "implementation", unit: "per_unit", currency: "CAD" }).ok);
    const ok = catalogue.validateCatalogueDraft({ sku: "integ", name: "Integration", category: "implementation", unit: "per_unit", unit_label: "integration", price_cents: 150000, currency: "CAD" });
    assert.ok(ok.ok);
    assert.equal(catalogue.confirmBlocker({ status: "proposed", price_cents: null }), "it has no price yet");
    assert.equal(catalogue.confirmBlocker({ status: "proposed", price_cents: 100 }), null);
  });

  console.log("profile");
  await check("a discovery fact is never an estimate, and Verified needs what confirmed it", () => {
    assert.ok(!profile.validateProfileField({ field_key: "sales.leads_per_month", value: 30, label: "estimate", source_type: "call_notes" }).ok);
    assert.ok(!profile.validateProfileField({ field_key: "sales.leads_per_month", value: 30, label: "verified", source_type: "call_notes" }).ok);
    assert.ok(profile.validateProfileField({ field_key: "sales.leads_per_month", value: "1,200", label: "client_reported", source_type: "call_notes" }).ok);
    assert.ok(!profile.validateProfileField({ field_key: "sales.close_rate_pct", value: 140, label: "client_reported", source_type: "call_notes" }).ok);
    const rows = profile.validateProfileField({ field_key: "ops.repetitive_tasks", value: "Invoices | 3 | owner\nQuotes | 2 | admin", label: "client_reported", source_type: "call_notes" });
    assert.ok(rows.ok && Array.isArray(rows.value.value) && (rows.value.value as Array<Record<string, string>>)[1].who === "admin");
  });

  console.log("delivery payload and links");
  const sha = "a".repeat(64);
  const good = { engagement_id: "e1", lead_id: "l1", business_name: "Fixture Co", audit_version_id: "a1", audit_sha256: sha, proposal_version_id: "p1", proposal_sha256: sha, pdf_sha256: sha, to: "owner@fixture.test", subject: "Your audit", body: "See {{audit_link}}", currency: "CAD", total_cents: 100, due_now_cents: 100 };
  await check("the final approval binds exact hashes and exactly one link placeholder", () => {
    assert.ok(payload.validateDeliverAiAuditPayload(good).ok);
    assert.ok(!payload.validateDeliverAiAuditPayload({ ...good, body: "no placeholder" }).ok);
    assert.ok(!payload.validateDeliverAiAuditPayload({ ...good, body: "{{audit_link}} {{audit_link}}" }).ok);
    assert.ok(!payload.validateDeliverAiAuditPayload({ ...good, pdf_sha256: "short" }).ok);
    assert.ok(!payload.validateDeliverAiAuditPayload({ ...good, subject: "two\nlines" }).ok);
    assert.match(payload.deliverAiAuditPreview(good), /Send Fixture Co their Free AI Audit/);
  });
  await check("the approvals module knows the kind, its label, its risk and its validator", async () => {
    const ar = await import("../lib/os/approvals/rules");
    assert.ok((ar.APPROVAL_ACTION_KINDS as readonly string[]).includes("deliver_ai_audit"));
    assert.equal(ar.DEFAULT_RISK.deliver_ai_audit, "spend");
    assert.ok(!ar.validatePayload("deliver_ai_audit", { ...good, to: "nope" }).ok);
    assert.match(ar.previewFor("deliver_ai_audit", good), /Free AI Audit/);
  });
  await check("link tokens: 32 bytes, derived from the approval key, stored only as a hash", () => {
    const t1 = link.mintLinkToken("s".repeat(40), "approval-key-1");
    assert.equal(t1, link.mintLinkToken("s".repeat(40), "approval-key-1"));
    assert.notEqual(t1, link.mintLinkToken("s".repeat(40), "approval-key-2"));
    assert.equal(Buffer.from(t1, "base64url").length, 32);
    assert.ok(link.isPlausibleToken(t1));
    assert.ok(!link.isPlausibleToken(`${t1}x`));
    assert.notEqual(link.tokenHash(t1), t1);
    assert.match(link.tokenHash(t1), /^[0-9a-f]{64}$/);
  });
  await check("the PDF render address: valid for its version and tenant only, and only for 15 minutes", () => {
    const secret = "r".repeat(40);
    const now = new Date("2026-10-25T12:00:00Z");
    const path = link.signRenderPath(secret, "tenant-a", "version-1", now);
    const q = new URL(`https://x${path}`).searchParams;
    const args = { tenantId: q.get("t"), versionId: "version-1", exp: q.get("exp"), sig: q.get("sig") };
    assert.ok(link.verifyRenderSignature(secret, args, now));
    assert.ok(!link.verifyRenderSignature(secret, { ...args, versionId: "version-2" }, now));
    assert.ok(!link.verifyRenderSignature(secret, { ...args, tenantId: "tenant-b" }, now));
    assert.ok(!link.verifyRenderSignature("x".repeat(40), args, now));
    assert.ok(!link.verifyRenderSignature(secret, args, new Date(now.getTime() + 16 * 60_000)));
  });
  await check("canonical JSON and the content hash ignore key order, not array order", () => {
    assert.equal(canonical.canonicalJson({ b: 1, a: [2, 1] }), canonical.canonicalJson({ a: [2, 1], b: 1 }));
    assert.notEqual(hash.contentHash({ a: [1, 2] }), hash.contentHash({ a: [2, 1] }));
    assert.match(hash.deterministicUuid("project:e1"), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(hash.deterministicUuid("project:e1"), hash.deterministicUuid("project:e1"));
  });

  console.log("send switches");
  await check("audit delivery and Stripe checkout are dry runs until their own switch is on", () => {
    assert.equal(sendMode.isDryRun("ai_audit_delivery"), true);
    assert.equal(sendMode.isDryRun("stripe_checkout"), true);
    process.env.LIVE_SEND_AI_AUDIT = "1";
    assert.equal(sendMode.isDryRun("ai_audit_delivery"), false);
    assert.equal(sendMode.isDryRun("email"), true, "turning audits live must not turn every approved email live");
    process.env.BRAVO_FORCE_DRY_RUN = "1";
    assert.equal(sendMode.isDryRun("ai_audit_delivery"), true, "the kill switch still wins");
    delete process.env.BRAVO_FORCE_DRY_RUN;
    delete process.env.LIVE_SEND_AI_AUDIT;
  });

  console.log("stripe requests");
  type Call = { url: string; init: RequestInit };
  const recorder = (calls: Call[]) =>
    (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ id: "cs_live_abc123", url: "https://checkout.stripe.com/c/pay/cs_live_abc123", livemode: true }), { status: 200 });
    }) as typeof fetch;
  const base = {
    secretKey: "sk_live_fake",
    tenantId: "t1",
    leadId: "l1",
    paymentToken: "11111111-1111-4111-8111-111111111111",
    paymentPlanId: "22222222-2222-4222-8222-222222222222",
    installmentKind: "full" as const,
    amountCents: 150_000,
    currency: "CAD" as const,
    customerEmail: "a@b.test",
    description: "Growth website setup payment",
    successUrl: "https://oasisai.work/pipeline/l1?payment=success",
    cancelUrl: "https://oasisai.work/pipeline/l1?payment=cancelled",
  };
  await check("the website-sales checkout request to Stripe is unchanged, byte for byte", async () => {
    const calls: Call[] = [];
    await payment.createStripeWebsiteCheckout({ ...base, fetchImpl: recorder(calls) });
    const expected = new URLSearchParams({
      mode: "payment",
      client_reference_id: "l1",
      success_url: base.successUrl,
      cancel_url: base.cancelUrl,
      "line_items[0][price_data][currency]": "cad",
      "line_items[0][price_data][unit_amount]": "150000",
      "line_items[0][price_data][product_data][name]": base.description,
      "line_items[0][quantity]": "1",
      "metadata[oasis_tenant_id]": "t1",
      "metadata[oasis_lead_id]": "l1",
      "metadata[oasis_payment_token]": base.paymentToken,
      "metadata[oasis_payment_plan_id]": base.paymentPlanId,
      "metadata[oasis_installment_kind]": "full",
      "payment_intent_data[metadata][oasis_tenant_id]": "t1",
      "payment_intent_data[metadata][oasis_lead_id]": "l1",
      "payment_intent_data[metadata][oasis_payment_token]": base.paymentToken,
      "payment_intent_data[metadata][oasis_payment_plan_id]": base.paymentPlanId,
      "payment_intent_data[metadata][oasis_installment_kind]": "full",
    });
    expected.set("customer_email", "a@b.test");
    assert.equal(String(calls[0].init.body), expected.toString());
    assert.equal((calls[0].init.headers as Record<string, string>)["Idempotency-Key"], `oasis-website-${base.paymentToken}`);
  });
  await check("the audit checkout adds its marker and its own idempotency prefix, and cannot overwrite a binding", async () => {
    const calls: Call[] = [];
    await payment.createStripeLeadCheckout({ ...base, idempotencyPrefix: "oasis-ai-audit-", extraMetadata: { oasis_checkout: "ai_audit_v1", oasis_engagement_id: "e1" }, fetchImpl: recorder(calls) });
    const body = new URLSearchParams(String(calls[0].init.body));
    assert.equal(body.get("metadata[oasis_checkout]"), "ai_audit_v1");
    assert.equal(body.get("payment_intent_data[metadata][oasis_engagement_id]"), "e1");
    assert.equal((calls[0].init.headers as Record<string, string>)["Idempotency-Key"], `oasis-ai-audit-${base.paymentToken}`);
    await assert.rejects(
      payment.createStripeLeadCheckout({ ...base, idempotencyPrefix: "oasis-ai-audit-", extraMetadata: { oasis_lead_id: "other" }, fetchImpl: recorder([]) }),
      /invalid_checkout_metadata/,
    );
  });

  if (failures) {
    console.log(`ai-audit-rules: ${failures} failure(s)`);
    process.exit(1);
  }
  console.log("ai-audit-rules: all passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
