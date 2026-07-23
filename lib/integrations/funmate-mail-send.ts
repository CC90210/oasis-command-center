import "server-only";
import { randomUUID } from "node:crypto";
import { getServiceSupabase } from "@/lib/supabase-server";
import { LEAD_DOC_BUCKET } from "@/lib/lead-documents";
import { getFunmateMailCredentials } from "./funmate-mail";
import type { ShopOutAttachment } from "@/lib/lenders/shop-out";

const MAX_TOTAL_BYTES = 24 * 1024 * 1024;

export async function sendFunmateMail(input: {
  to: string;
  cc?: string[];
  subject: string;
  text: string;
  tenantId: string;
  attachments: ShopOutAttachment[];
}) {
  const creds = getFunmateMailCredentials();
  const db = getServiceSupabase();
  const files: Array<{ filename: string; content: Buffer; contentType: string }> = [];
  let total = 0;
  for (const attachment of input.attachments) {
    if (!attachment.storage_path.startsWith(`${input.tenantId}/`) || attachment.storage_path.includes("..")) {
      return { ok: false as const, error: "funmate_attachment_outside_tenant" };
    }
    const download = await db.storage.from(LEAD_DOC_BUCKET).download(attachment.storage_path);
    if (download.error || !download.data) {
      return { ok: false as const, error: `funmate_attachment_download_failed:${attachment.filename}` };
    }
    const content = Buffer.from(await download.data.arrayBuffer());
    total += content.length;
    if (total > MAX_TOTAL_BYTES) return { ok: false as const, error: "funmate_attachments_too_large" };
    files.push({ filename: attachment.filename, content, contentType: attachment.mime_type });
  }

  try {
    const nodemailer = await import("nodemailer");
    const transport = nodemailer.createTransport({
      host: creds.smtpHost,
      port: creds.smtpPort,
      secure: creds.smtpSecure,
      requireTLS: !creds.smtpSecure,
      auth: { user: creds.email, pass: creds.appPassword },
    });
    const senderDomain = creds.email.split("@")[1] || "localhost";
    const rfc822 = `<${randomUUID()}@${senderDomain}>`;
    const result = await transport.sendMail({
      from: `Funmate Deal Desk <${creds.email}>`,
      to: input.to,
      cc: input.cc?.length ? input.cc.join(", ") : undefined,
      subject: input.subject,
      text: input.text,
      attachments: files,
      headers: { "Message-Id": rfc822, "X-SunBiz-Route": "funmate" },
    });
    return { ok: true as const, messageId: result.messageId, rfc822MessageId: rfc822 };
  } catch (error) {
    return { ok: false as const, error: (error instanceof Error ? error.message : "funmate_send_failed").slice(0, 240) };
  }
}
