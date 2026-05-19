import { randomUUID } from "crypto";
import { getServiceSupabase } from "./supabase-server";
import { sanitizeStorageFilename } from "./storage-helpers";

export const CHAT_ATTACHMENT_BUCKET = "chat-attachments";
export const MAX_CHAT_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_CHAT_ATTACHMENTS_PER_TURN = 5;
export const MAX_ATTACHMENT_PROMPT_CHARS = 24_000;
export const MAX_ATTACHMENT_TEXT_CHARS = 120_000;

export const CHAT_ATTACHMENT_ALLOWED_MIME = new Set<string>([
  "text/plain",
  "text/csv",
  "text/markdown",
  "application/json",
  "application/xml",
  "text/xml",
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/heic",
  "image/heif",
]);

export type ChatAttachmentRow = {
  id: string;
  tenant_id: string;
  auth_user_id: string;
  session_id: string | null;
  agent_key: string | null;
  filename: string;
  storage_bucket: string;
  storage_path: string;
  mime_type: string | null;
  size_bytes: number;
  parser: string;
  text_excerpt: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
};

export type ChatAttachmentSummary = {
  id: string;
  filename: string;
  mime_type: string | null;
  size_bytes: number;
  parser: string;
  text_excerpt?: string | null;
};

export type UploadChatAttachmentInput = {
  tenantId: string;
  userId: string;
  agentKey?: string | null;
  sessionId?: string | null;
  filename: string;
  mimeType: string;
  bytes: Buffer | Uint8Array;
  sizeBytes: number;
};

export async function uploadChatAttachment(input: UploadChatAttachmentInput): Promise<ChatAttachmentRow> {
  const db = getServiceSupabase();
  const cleanName = sanitizeStorageFilename(input.filename);
  const safeMime = (input.mimeType || "application/octet-stream").toLowerCase();
  const extracted = extractAttachmentText(cleanName, safeMime, input.bytes);
  const storagePath = `${input.tenantId}/${input.userId}/${Date.now()}_${randomUUID()}_${cleanName}`;

  const upload = await db.storage.from(CHAT_ATTACHMENT_BUCKET).upload(storagePath, input.bytes, {
    contentType: safeMime,
    upsert: false,
  });
  if (upload.error) {
    throw new Error(`upload_failed: ${upload.error.message}`);
  }

  const inserted = await db
    .from("chat_attachments")
    .insert({
      tenant_id: input.tenantId,
      auth_user_id: input.userId,
      session_id: input.sessionId || null,
      agent_key: input.agentKey || null,
      filename: cleanName,
      storage_bucket: CHAT_ATTACHMENT_BUCKET,
      storage_path: storagePath,
      mime_type: safeMime,
      size_bytes: input.sizeBytes,
      parser: extracted.parser,
      text_excerpt: extracted.text,
      metadata: {
        original_filename: input.filename,
        truncated: extracted.truncated,
      },
    })
    .select("*")
    .single();

  if (inserted.error || !inserted.data) {
    await db.storage.from(CHAT_ATTACHMENT_BUCKET).remove([storagePath]);
    throw new Error(`metadata_insert_failed: ${inserted.error?.message || "missing_row"}`);
  }

  return inserted.data as ChatAttachmentRow;
}

export async function loadChatAttachmentsForTurn(input: {
  tenantId: string;
  userId: string;
  attachmentIds: string[];
}): Promise<ChatAttachmentRow[]> {
  const ids = Array.from(new Set(input.attachmentIds.filter(isUuid))).slice(0, MAX_CHAT_ATTACHMENTS_PER_TURN);
  if (ids.length === 0) return [];

  const db = getServiceSupabase();
  const { data, error } = await db
    .from("chat_attachments")
    .select("*")
    .eq("tenant_id", input.tenantId)
    .eq("auth_user_id", input.userId)
    .in("id", ids);
  if (error) throw new Error(`attachment_lookup_failed: ${error.message}`);

  const byId = new Map((data || []).map((row) => [row.id as string, row as ChatAttachmentRow]));
  return ids.map((id) => byId.get(id)).filter((row): row is ChatAttachmentRow => Boolean(row));
}

export async function linkChatAttachmentsToSession(input: {
  tenantId: string;
  userId: string;
  sessionId: string;
  attachmentIds: string[];
}) {
  const ids = Array.from(new Set(input.attachmentIds.filter(isUuid))).slice(0, MAX_CHAT_ATTACHMENTS_PER_TURN);
  if (ids.length === 0) return;
  const db = getServiceSupabase();
  await db
    .from("chat_attachments")
    .update({ session_id: input.sessionId })
    .eq("tenant_id", input.tenantId)
    .eq("auth_user_id", input.userId)
    .in("id", ids);
}

export function summarizeAttachment(row: ChatAttachmentRow): ChatAttachmentSummary {
  return {
    id: row.id,
    filename: row.filename,
    mime_type: row.mime_type,
    size_bytes: row.size_bytes,
    parser: row.parser,
    text_excerpt: row.text_excerpt,
  };
}

export function formatAttachmentContext(rows: ChatAttachmentRow[]): string {
  if (rows.length === 0) return "";
  const lines: string[] = [
    "",
    "---",
    "ATTACHED FILES FOR THIS TURN",
    "These files were uploaded through the chat attachment button and stored in the private chat_attachments table + Storage bucket. Treat the excerpts as operator-provided context. If the operator asks to update the CRM, use create_record/update_record/search_records or the import_leads_from_attachment tool when this is a lead CSV. If the operator asks to send email/SMS, draft first and only call send_email/send_sms after an explicit send instruction.",
    "",
  ];
  rows.forEach((row, idx) => {
    lines.push(
      `[${idx + 1}] ${row.filename}`,
      `attachment_id: ${row.id}`,
      `mime_type: ${row.mime_type || "unknown"}`,
      `size_bytes: ${row.size_bytes}`,
      `parser: ${row.parser}`,
    );
    if (row.text_excerpt) {
      const excerpt =
        row.text_excerpt.length > MAX_ATTACHMENT_PROMPT_CHARS
          ? `${row.text_excerpt.slice(0, MAX_ATTACHMENT_PROMPT_CHARS)}\n[truncated for prompt; full file remains in storage]`
          : row.text_excerpt;
      lines.push("excerpt:", excerpt);
    } else {
      lines.push("excerpt: [binary file stored; no text extracted yet]");
    }
    lines.push("");
  });
  lines.push("---");
  return lines.join("\n");
}

export function injectAttachmentContextIntoMessages<T extends { role: string; content: string }>(
  messages: T[],
  context: string,
): T[] {
  if (!context.trim()) return messages;
  const next = messages.map((m) => ({ ...m }));
  for (let i = next.length - 1; i >= 0; i--) {
    if (next[i].role === "user") {
      next[i].content = `${next[i].content}\n\n${context}`;
      break;
    }
  }
  return next;
}

export async function downloadChatAttachmentText(input: {
  tenantId: string;
  userId: string;
  attachmentId: string;
}): Promise<{ row: ChatAttachmentRow; text: string }> {
  if (!isUuid(input.attachmentId)) throw new Error("invalid_attachment_id");
  const db = getServiceSupabase();
  const { data, error } = await db
    .from("chat_attachments")
    .select("*")
    .eq("tenant_id", input.tenantId)
    .eq("auth_user_id", input.userId)
    .eq("id", input.attachmentId)
    .maybeSingle();
  if (error) throw new Error(`attachment_lookup_failed: ${error.message}`);
  if (!data) throw new Error("attachment_not_found");
  const row = data as ChatAttachmentRow;
  if (!row.storage_path.startsWith(`${input.tenantId}/`)) {
    throw new Error("storage_path_mismatch");
  }

  const downloaded = await db.storage.from(CHAT_ATTACHMENT_BUCKET).download(row.storage_path);
  if (downloaded.error || !downloaded.data) {
    throw new Error(`attachment_download_failed: ${downloaded.error?.message || "missing_blob"}`);
  }
  const bytes = Buffer.from(await downloaded.data.arrayBuffer());
  const extracted = extractAttachmentText(row.filename, row.mime_type || "", bytes, 2_000_000);
  if (!extracted.text) throw new Error("attachment_has_no_extractable_text");
  return { row, text: extracted.text };
}

function extractAttachmentText(
  filename: string,
  mimeType: string,
  bytes: Buffer | Uint8Array,
  maxChars = MAX_ATTACHMENT_TEXT_CHARS,
): { parser: string; text: string | null; truncated: boolean } {
  const lowerName = filename.toLowerCase();
  const lowerMime = mimeType.toLowerCase();
  const isTextLike =
    lowerMime.startsWith("text/") ||
    lowerMime.includes("json") ||
    lowerMime.includes("xml") ||
    lowerName.endsWith(".csv") ||
    lowerName.endsWith(".txt") ||
    lowerName.endsWith(".md") ||
    lowerName.endsWith(".json");
  if (!isTextLike) return { parser: "metadata_only", text: null, truncated: false };

  const decoded = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  const cleaned = decoded.replace(/\u0000/g, "").trim();
  if (!cleaned) return { parser: "text_empty", text: null, truncated: false };
  const truncated = cleaned.length > maxChars;
  return {
    parser: lowerName.endsWith(".csv") || lowerMime.includes("csv") ? "csv_text" : "plain_text",
    text: truncated ? cleaned.slice(0, maxChars) : cleaned,
    truncated,
  };
}

function isUuid(v: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}
