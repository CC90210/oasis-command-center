/**
 * Production Shopping Out email acceptance canary.
 *
 * Uses permanent, clearly-labelled test merchant/lender fixtures and the exact
 * production sender. No real merchant, lender, or merchant document is used;
 * the attachment is a permanent synthetic fixture in the production bucket.
 *
 * Run through JARVIS/scripts/run_oasis_acceptance.mjs so production credentials
 * are passed in-memory and never written or printed.
 */
import "server-only";
import { createHash } from "node:crypto";
import { getServiceSupabase } from "@/lib/supabase-server";
import { sendSunbizLenderMail } from "@/lib/integrations/sunbiz-lender-mail-send";
import { LEAD_DOC_BUCKET } from "@/lib/lead-documents";
import {
  normalizeShopOutText,
  renderShopOutHtml,
  SHOP_OUT_EMAIL_TEMPLATES,
} from "@/lib/lenders/shop-out-email-templates";

const TENANT = "aa04fa1f-ad6a-44b0-ac4b-2ff5d1067110";
const TEST_LENDER_ID = "40774cae-d92d-4ef1-9b8a-6366dc25c677";
const TEST_APPLICATION_ID = "c0a6b365-e31c-47eb-8e78-ccad1f57e03e";
const TEST_ATTACHMENT_PATH = `${TENANT}/acceptance/shopout-email-canary.txt`;
const EXPECTED_DESTINATION = "adonyess@gmail.com";
const SEND = process.argv.includes("--send");
const runKey = process.env.OASIS_ACCEPTANCE_RUN_ID || new Date().toISOString().slice(0, 10);
const receiptHash = createHash("sha256").update(`shopout-email:${runKey}`).digest("hex");
const ACCEPTANCE_RECEIPT_ID = `${receiptHash.slice(0, 8)}-${receiptHash.slice(8, 12)}-4${receiptHash.slice(13, 16)}-8${receiptHash.slice(17, 20)}-${receiptHash.slice(20, 32)}`;

type Check = { id: number; name: string; ok: boolean; detail: string };
const checks: Check[] = [];
function check(name: string, ok: boolean, detail: string) {
  checks.push({ id: checks.length + 1, name, ok, detail });
  if (!ok) throw new Error(`check_${checks.length}_failed:${name}:${detail}`);
}

async function main() {
const db = getServiceSupabase();
const lender = await db
  .from("tenant_records")
  .select("id, entity_type, data")
  .eq("tenant_id", TENANT)
  .eq("id", TEST_LENDER_ID)
  .maybeSingle();
check("permanent test lender exists", !lender.error && lender.data?.entity_type === "lender", lender.error?.message || "found");

const lenderData = (lender.data?.data || {}) as Record<string, unknown>;
const destination = Array.isArray(lenderData.submission_emails)
  ? String(lenderData.submission_emails[0] || "")
  : String(lenderData.contact || "");
check("test lender is owner-controlled", destination === EXPECTED_DESTINATION, "destination allowlist matched");

const application = await db
  .from("tenant_records")
  .select("id, entity_type, data")
  .eq("tenant_id", TENANT)
  .eq("id", TEST_APPLICATION_ID)
  .maybeSingle();
check("permanent test merchant application exists", !application.error && application.data?.entity_type === "application", application.error?.message || "found");

const app = (application.data?.data || {}) as Record<string, unknown>;
check("fixture cannot be mistaken for a live deal", app.is_test === true && app.created_via === "shopout_template_canary", "is_test and canary source confirmed");

const money = (value: unknown) =>
  typeof value === "number" ? new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(value) : "Not provided";
const renderedTemplates = SHOP_OUT_EMAIL_TEMPLATES.map((template) => {
  const text = normalizeShopOutText(template.body
    .replaceAll("{{application.business_name}}", String(app.business_name || "SunBiz Acceptance Canary LLC"))
    .replaceAll("{{application.monthly_revenue_display}}", money(app.monthly_revenue))
    .replaceAll("{{application.position_count_display}}", String(app.position_count ?? "Not provided"))
    .replaceAll("{{application.requested_amount_display}}", money(app.requested_amount))
    .replaceAll("{{lender.name}}", String(lenderData.name || "Test Lender"))
    .replace(/Application \+ 3 months of bank statements are attached\.[^\n]*/gi, "A synthetic acceptance-test attachment is included; it contains no merchant data.")
    .replace(/The application and 3 months of bank statements are attached\.[^\n]*/gi, "A synthetic acceptance-test attachment is included; it contains no merchant data.")
    .replace(/Documents attached:\s*\n- Funding application\s*\n- 3 months of business bank statements/gi, "Document attached: synthetic acceptance-test fixture (no merchant data)"), "Matt");
  return { text, html: renderShopOutHtml(text, "submissions@sunbizfunding.com") };
});
const body = renderedTemplates[0].text;
check("template tokens rendered", renderedTemplates.every(({ text }) => !text.includes("{{")), "all templates have no unresolved tokens");
check("SunBiz branded HTML rendered", renderedTemplates.every(({ html }) => html.includes("Lender Submissions") && html.includes("#001f54") && html.includes("#d4a843")), "all templates have the navy/gold shell");
check("shared identity rendered once", renderedTemplates.every(({ html }) => (html.match(/SunBiz Submissions/g) || []).length === 1 && !/\bMatt\b/i.test(html)), "all templates contain no rep identity leak");

const normalizedTwice = normalizeShopOutText(normalizeShopOutText(`${body}\n\nRegards,\nMatt`, "Matt"), "Matt");
check(
  "fallback and idempotency guards",
  normalizedTwice.endsWith("SunBiz Submissions\nSunBiz Funding") &&
    !/\bMatt\b/i.test(normalizedTwice) &&
    normalizedTwice === normalizeShopOutText(normalizedTwice, "Matt"),
  "legacy signature rejected and normalization is idempotent",
);

if (!SEND) {
  checks.push({ id: 9, name: "SMTP acceptance", ok: false, detail: "not run: pass --send for the authorized external canary" });
  checks.push({ id: 10, name: "provider receipt recorded", ok: false, detail: "not run" });
} else {
  const fixtureBytes = Buffer.from("SUNBIZ AUTOMATED ACCEPTANCE FIXTURE\nNo merchant or lender data.\n", "utf8");
  const fixtureRead = await db.storage.from(LEAD_DOC_BUCKET).download(TEST_ATTACHMENT_PATH);
  if (fixtureRead.error || !fixtureRead.data) {
    const upload = await db.storage.from(LEAD_DOC_BUCKET).upload(TEST_ATTACHMENT_PATH, fixtureBytes, {
      contentType: "text/plain",
      upsert: false,
    });
    if (upload.error) throw new Error(`acceptance_fixture_upload_failed:${upload.error.message}`);
  } else {
    const storedBytes = Buffer.from(await fixtureRead.data.arrayBuffer());
    if (!storedBytes.equals(fixtureBytes)) throw new Error("acceptance_fixture_content_mismatch: refusing external send");
  }

  const reservedAt = new Date().toISOString();
  const reservation = {
    is_test: true, canary: "shopout_email", run_key: runKey, status: "reserved",
    application_id: TEST_APPLICATION_ID, lender_id: TEST_LENDER_ID, reserved_at: reservedAt,
  };
  const reserve = await db.from("tenant_records").insert({ id: ACCEPTANCE_RECEIPT_ID, tenant_id: TENANT, entity_type: "acceptance_run", data: reservation });
  if (reserve.error) {
    const prior = await db.from("tenant_records").select("data").eq("tenant_id", TENANT).eq("id", ACCEPTANCE_RECEIPT_ID).maybeSingle();
    const priorData = (prior.data?.data || {}) as Record<string, unknown>;
    if (prior.error || !prior.data) throw new Error(`acceptance_reservation_failed:${reserve.error.message}`);
    if (priorData.status === "sent" && typeof priorData.provider_message_id === "string") {
      check("SMTP acceptance", true, "idempotent retry reused the recorded Gmail SMTP acceptance");
      check("durable provider receipt verified", true, "existing sent receipt read back");
      const ok = checks.length === 10 && checks.every((item) => item.ok);
      console.log(JSON.stringify({ ok, complete: ok, sent: SEND, checks }, null, 2));
      return;
    }
    throw new Error("acceptance_run_already_reserved: verify provider state before choosing a new run id");
  }

  const result = await sendSunbizLenderMail({
      to: destination,
      subject: `[AUTOMATED TEST] SunBiz Shopping Out Template - ${new Date().toISOString()}`,
      text: body,
      tenantId: TENANT,
      attachments: [{ filename: "SUNBIZ-AUTOMATED-TEST.txt", storage_path: TEST_ATTACHMENT_PATH, mime_type: "text/plain", size_bytes: fixtureBytes.length }],
      signerName: "Matt",
      threadRootId: `<shopout-canary-${runKey.replace(/[^a-z0-9-]/gi, "-")}@sunbizfunding.com>`,
  });
  check("SMTP acceptance", result.ok, result.ok ? "accepted by Gmail SMTP" : result.error);
  if (!result.ok) throw new Error("provider receipt unavailable after failed send");
  const receipt = {
    is_test: true,
    canary: "shopout_email",
    application_id: TEST_APPLICATION_ID,
    lender_id: TEST_LENDER_ID,
    provider_message_id: result.messageId,
    run_key: runKey,
    status: "sent",
    sent_at: new Date().toISOString(),
  };
  const write = await db
        .from("tenant_records")
        .update({ data: receipt, updated_at: receipt.sent_at })
        .eq("tenant_id", TENANT)
        .eq("id", ACCEPTANCE_RECEIPT_ID);
  if (write.error) throw new Error(`acceptance_receipt_write_failed:${write.error.message}`);
  const readback = await db
    .from("tenant_records")
    .select("data")
    .eq("tenant_id", TENANT)
    .eq("id", ACCEPTANCE_RECEIPT_ID)
    .maybeSingle();
  const saved = (readback.data?.data || {}) as Record<string, unknown>;
  check(
    "durable provider receipt verified",
    !readback.error && saved.provider_message_id === result.messageId && saved.is_test === true,
    readback.error?.message || "receipt written and read back",
  );
}

const ok = checks.length === 10 && checks.every((c) => c.ok);
console.log(JSON.stringify({ ok, complete: ok, sent: SEND, checks }, null, 2));
if (!ok) process.exitCode = 2;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "shopout_canary_failed");
  process.exit(1);
});
