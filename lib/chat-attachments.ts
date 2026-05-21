import { createHmac, randomUUID, timingSafeEqual } from "crypto";
import { getServiceSupabase } from "./supabase-server";
import { sanitizeStorageFilename } from "./storage-helpers";

export const CHAT_ATTACHMENT_BUCKET = "chat-attachments";
export const MAX_CHAT_ATTACHMENTS_PER_TURN = 5;
export const MAX_ATTACHMENT_PROMPT_CHARS = 24_000;
export const MAX_ATTACHMENT_TEXT_CHARS = 120_000;
export const CHAT_ATTACHMENT_SIGNED_TOKEN_TTL_SECONDS = 30 * 60;

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

type SignedUploadTokenPayload = {
  v: 1;
  exp: number;
  nonce: string;
  tenant_id: string;
  auth_user_id: string;
  storage_path: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  agent_key: string | null;
  session_id: string | null;
};

export type CreateChatAttachmentSignedUploadInput = {
  tenantId: string;
  userId: string;
  agentKey?: string | null;
  sessionId?: string | null;
  filename: string;
  mimeType?: string | null;
  sizeBytes: number;
};

export type ChatAttachmentSignedUpload = {
  filename: string;
  storage_path: string;
  mime_type: string;
  size_bytes: number;
  signed_url: string;
  upload_token: string;
  completion_token: string;
  expires_at: string;
};

export async function uploadChatAttachment(input: UploadChatAttachmentInput): Promise<ChatAttachmentRow> {
  const db = getServiceSupabase();
  const cleanName = sanitizeStorageFilename(input.filename);
  const safeMime = normalizeAttachmentMimeType(cleanName, input.mimeType);
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

export async function createChatAttachmentSignedUpload(
  input: CreateChatAttachmentSignedUploadInput,
): Promise<ChatAttachmentSignedUpload> {
  const db = getServiceSupabase();
  const cleanName = sanitizeStorageFilename(input.filename || "attachment");
  const safeMime = normalizeAttachmentMimeType(cleanName, input.mimeType);
  const sizeBytes = normalizeSizeBytes(input.sizeBytes);
  const storagePath = `${input.tenantId}/${input.userId}/${Date.now()}_${randomUUID()}_${cleanName}`;
  const expiresAtSeconds = Math.floor(Date.now() / 1000) + CHAT_ATTACHMENT_SIGNED_TOKEN_TTL_SECONDS;

  const signed = await db.storage.from(CHAT_ATTACHMENT_BUCKET).createSignedUploadUrl(storagePath, {
    upsert: false,
  });
  if (signed.error || !signed.data?.token) {
    throw new Error(`signed_upload_failed: ${signed.error?.message || "missing_token"}`);
  }

  const payload: SignedUploadTokenPayload = {
    v: 1,
    exp: expiresAtSeconds,
    nonce: randomUUID(),
    tenant_id: input.tenantId,
    auth_user_id: input.userId,
    storage_path: storagePath,
    filename: cleanName,
    mime_type: safeMime,
    size_bytes: sizeBytes,
    agent_key: input.agentKey || null,
    session_id: input.sessionId || null,
  };

  return {
    filename: cleanName,
    storage_path: storagePath,
    mime_type: safeMime,
    size_bytes: sizeBytes,
    signed_url: signed.data.signedUrl,
    upload_token: signed.data.token,
    completion_token: signUploadCompletionToken(payload),
    expires_at: new Date(expiresAtSeconds * 1000).toISOString(),
  };
}

export async function completeChatAttachmentUpload(input: {
  tenantId: string;
  userId: string;
  completionToken: string;
  parser?: string | null;
  textExcerpt?: string | null;
  truncated?: boolean | null;
}): Promise<ChatAttachmentRow> {
  const payload = verifyUploadCompletionToken(input.completionToken);
  if (payload.tenant_id !== input.tenantId || payload.auth_user_id !== input.userId) {
    throw new Error("completion_token_context_mismatch");
  }

  const db = getServiceSupabase();
  const objectInfo = await db.storage.from(CHAT_ATTACHMENT_BUCKET).info(payload.storage_path);
  if (objectInfo.error || !objectInfo.data) {
    throw new Error(`uploaded_object_not_found: ${objectInfo.error?.message || "missing_blob"}`);
  }

  const textExcerpt = normalizeTextExcerpt(input.textExcerpt);
  const parser =
    textExcerpt && textExcerpt.trim()
      ? normalizeParser(input.parser, payload.filename, payload.mime_type)
      : "metadata_only";

  const inserted = await db
    .from("chat_attachments")
    .insert({
      tenant_id: payload.tenant_id,
      auth_user_id: payload.auth_user_id,
      session_id: payload.session_id,
      agent_key: payload.agent_key,
      filename: payload.filename,
      storage_bucket: CHAT_ATTACHMENT_BUCKET,
      storage_path: payload.storage_path,
      mime_type: payload.mime_type,
      size_bytes: payload.size_bytes,
      parser,
      text_excerpt: textExcerpt,
      metadata: {
        original_filename: payload.filename,
        direct_upload: true,
        truncated: Boolean(input.truncated),
        storage_info: objectInfo.data,
      },
    })
    .select("*")
    .single();

  if (inserted.error || !inserted.data) {
    await db.storage.from(CHAT_ATTACHMENT_BUCKET).remove([payload.storage_path]);
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

export function normalizeAttachmentMimeType(filename: string, mimeType?: string | null): string {
  const supplied = (mimeType || "").trim().toLowerCase();
  if (supplied && supplied !== "application/octet-stream") return supplied;
  return mimeFromName(filename) || supplied || "application/octet-stream";
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

function normalizeSizeBytes(sizeBytes: number): number {
  if (!Number.isFinite(sizeBytes) || sizeBytes < 0) return 0;
  return Math.trunc(sizeBytes);
}

function normalizeTextExcerpt(value?: string | null): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/\u0000/g, "").trim();
  if (!cleaned) return null;
  return cleaned.length > MAX_ATTACHMENT_TEXT_CHARS
    ? cleaned.slice(0, MAX_ATTACHMENT_TEXT_CHARS)
    : cleaned;
}

function normalizeParser(parser: string | null | undefined, filename: string, mimeType: string): string {
  if (parser === "csv_text" || parser === "plain_text") return parser;
  const lowerName = filename.toLowerCase();
  const lowerMime = mimeType.toLowerCase();
  return lowerName.endsWith(".csv") || lowerMime.includes("csv") ? "csv_text" : "plain_text";
}

function mimeFromName(name: string): string | null {
  const lower = name.toLowerCase();
  if (lower.endsWith(".csv")) return "text/csv";
  if (lower.endsWith(".txt")) return "text/plain";
  if (lower.endsWith(".md")) return "text/markdown";
  if (lower.endsWith(".json")) return "application/json";
  if (lower.endsWith(".xml")) return "application/xml";
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".doc")) return "application/msword";
  if (lower.endsWith(".docx")) {
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  }
  if (lower.endsWith(".xls")) return "application/vnd.ms-excel";
  if (lower.endsWith(".xlsx")) {
    return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  }
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".heic")) return "image/heic";
  if (lower.endsWith(".heif")) return "image/heif";
  return null;
}

function signUploadCompletionToken(payload: SignedUploadTokenPayload): string {
  const body = base64UrlEncode(JSON.stringify(payload));
  const sig = createHmac("sha256", attachmentSigningKey()).update(body).digest("base64url");
  return `${body}.${sig}`;
}

function verifyUploadCompletionToken(token: string): SignedUploadTokenPayload {
  const [body, sig] = token.split(".");
  if (!body || !sig) throw new Error("invalid_completion_token");
  const expected = createHmac("sha256", attachmentSigningKey()).update(body).digest("base64url");
  if (!safeEqual(sig, expected)) throw new Error("invalid_completion_token_signature");

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    throw new Error("invalid_completion_token_payload");
  }
  if (!isSignedUploadTokenPayload(parsed)) throw new Error("invalid_completion_token_payload");
  if (parsed.exp < Math.floor(Date.now() / 1000)) throw new Error("completion_token_expired");
  return parsed;
}

function isSignedUploadTokenPayload(value: unknown): value is SignedUploadTokenPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    v.v === 1 &&
    typeof v.exp === "number" &&
    typeof v.nonce === "string" &&
    typeof v.tenant_id === "string" &&
    typeof v.auth_user_id === "string" &&
    typeof v.storage_path === "string" &&
    typeof v.filename === "string" &&
    typeof v.mime_type === "string" &&
    typeof v.size_bytes === "number" &&
    (typeof v.agent_key === "string" || v.agent_key === null) &&
    (typeof v.session_id === "string" || v.session_id === null)
  );
}

function base64UrlEncode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function attachmentSigningKey(): string {
  const key =
    process.env.CHAT_ATTACHMENT_HMAC_KEY ||
    process.env.CHAT_RESUME_HMAC_KEY ||
    process.env.OASIS_OUTBOUND_HMAC_SECRET ||
    process.env.BRAVO_SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error("attachment_signing_key_missing");
  return key;
}
