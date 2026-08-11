import "server-only";
import { randomUUID } from "node:crypto";
import { getServiceSupabase } from "@/lib/supabase-server";
import { LEAD_DOC_BUCKET } from "@/lib/lead-documents";
import { getSubmissionsCreds, type SubmissionsCreds } from "./submissions-gmail";
import type { ShopOutAttachment } from "@/lib/lenders/shop-out";

/**
 * Send one lender package from the web app, over SMTP, with the branded bank
 * statements attached.
 *
 * WHY THIS EXISTS
 * ---------------
 * Shopping out used to dispatch through a chain: this route -> /api/bridge/
 * exec-tool -> a Python daemon on the Hostinger VPS -> send_gateway.py -> SMTP.
 * That chain broke in three independent places during the 2026-08-09 Turso
 * cutover, and each fix revealed the next one:
 *
 *   1. bravo_cli/bridge_tools.py hard-required BRAVO_SUPABASE_URL and raised
 *      before the Turso compat shim could route the call.
 *   2. send_gateway.get_supabase() had its OWN copy of that requirement, so
 *      fixing (1) just moved the failure one process to the right.
 *   3. The VPS has no Cloudflare R2 credentials at all, and the module that
 *      resolves them (scripts/etl_storage_to_r2.py) does not exist on that box.
 *      So even with a database, the sender could not download the very
 *      statements it exists to attach.
 *
 * (3) is not a bug to patch. It is the architecture telling us something: the
 * bytes live in R2, and the web app is the process that HAS R2, has the SMTP
 * credential, and produced the watermarked copies in the first place. Handing
 * all of that to a second machine so it can hand it back is the reason there
 * were three failure points instead of zero.
 *
 * FundMate already sends this way (lib/integrations/funmate-mail-send.ts) and
 * has never had any of these outages. This is its SunBiz twin. Deliberately a
 * near-copy rather than a shared abstraction: the two brands must never share a
 * From address, a credential, or a suppression list, and a single parameterised
 * sender is exactly how that leaks. See [[feedback_never_mention_lenders]] for
 * why SunBiz identity is load-bearing.
 */

/** Gmail rejects well before this, but a 25MB message is already a deliverability
 *  problem. Fail loudly here rather than let the SMTP server decide. */
const MAX_TOTAL_BYTES = 24 * 1024 * 1024;

export type SunbizLenderSendResult =
  | { ok: true; messageId: string; rfc822MessageId: string }
  | { ok: false; error: string };

export async function sendSunbizLenderMail(input: {
  to: string;
  cc?: string[];
  subject: string;
  text: string;
  tenantId: string;
  /** The WATERMARKED derived copies, as resolved by watermarkAttachmentsForShopOut. */
  attachments: ShopOutAttachment[];
  /** Rep whose name signs the mail. The shared inbox is always the From. */
  signerName?: string;
}): Promise<SunbizLenderSendResult> {
  let creds: SubmissionsCreds;
  try {
    // Brand is passed EXPLICITLY. submissions-gmail's own header warns that
    // letting it fall back sends one brand's copy from another brand's mailbox;
    // lender submissions are SunBiz by definition, so name it.
    creds = await getSubmissionsCreds(input.tenantId, "sunbiz");
  } catch (error) {
    // A missing or rotated app password is a BLOCKED state a human must clear,
    // not a transient fault to retry into. Name it so the operator sees the
    // actual remedy instead of "send failed".
    return {
      ok: false,
      error: `sunbiz_smtp_credentials_unavailable: ${
        error instanceof Error ? error.message : "unknown"
      }`.slice(0, 240),
    };
  }

  const db = getServiceSupabase();
  const files: Array<{ filename: string; content: Buffer; contentType: string }> = [];
  let total = 0;

  for (const attachment of input.attachments) {
    // Tenant-prefix check before any read. `storage_path` reaches this function
    // from a request body, and an unchecked path is how one tenant's bank
    // statements end up attached to another tenant's email.
    if (
      !attachment.storage_path.startsWith(`${input.tenantId}/`) ||
      attachment.storage_path.includes("..")
    ) {
      return { ok: false, error: "sunbiz_attachment_outside_tenant" };
    }

    const download = await db.storage.from(LEAD_DOC_BUCKET).download(attachment.storage_path);
    if (download.error || !download.data) {
      // Never send a lender package with statements silently missing — a funder
      // reading an incomplete file declines the deal and the merchant is told
      // the market passed. Refuse the whole send instead.
      return {
        ok: false,
        error: `sunbiz_attachment_download_failed:${attachment.filename}`,
      };
    }

    const content = Buffer.from(await download.data.arrayBuffer());
    total += content.length;
    if (total > MAX_TOTAL_BYTES) {
      return { ok: false, error: "sunbiz_attachments_too_large" };
    }
    files.push({
      filename: attachment.filename,
      content,
      contentType: attachment.mime_type,
    });
  }

  try {
    const nodemailer = await import("nodemailer");
    const transport = nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 587,
      secure: false,
      requireTLS: true,
      auth: { user: creds.fromAddress, pass: creds.appPassword },
    });

    // Stable RFC2822 Message-Id so Gmail threads the lender's reply back to this
    // send, and so the reply classifier can correlate it. Without the API this
    // header IS the thread key.
    const senderDomain = creds.fromAddress.split("@")[1] || "sunbizfunding.com";
    const rfc822 = `<${randomUUID()}@${senderDomain}>`;

    const result = await transport.sendMail({
      // Shared-inbox model: the From is always the tenant address, and the rep
      // stays on the thread by being CC'd. The display name carries the rep so a
      // funder still sees who they are dealing with.
      from: `${input.signerName || "SunBiz Funding"} <${creds.fromAddress}>`,
      to: input.to,
      cc: input.cc?.length ? input.cc.join(", ") : undefined,
      subject: input.subject,
      text: input.text,
      attachments: files,
      headers: { "Message-Id": rfc822, "X-SunBiz-Route": "sunbiz-direct" },
    });

    return {
      ok: true,
      messageId: result.messageId,
      rfc822MessageId: rfc822,
    };
  } catch (error) {
    return {
      ok: false,
      error: (error instanceof Error ? error.message : "sunbiz_send_failed").slice(0, 240),
    };
  }
}
