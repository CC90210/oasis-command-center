import { NextRequest, NextResponse } from "next/server";
import { resolveSessionContext } from "@/lib/api-auth";
import {
  CHAT_ATTACHMENT_ALLOWED_MIME,
  MAX_CHAT_ATTACHMENT_BYTES,
  MAX_CHAT_ATTACHMENTS_PER_TURN,
  summarizeAttachment,
  uploadChatAttachment,
} from "@/lib/chat-attachments";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const sess = await resolveSessionContext();
  if (!sess.ok) {
    return NextResponse.json({ ok: false, error: sess.reason }, { status: 401 });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ ok: false, error: "expected_multipart" }, { status: 400 });
  }

  const rawFiles = form.getAll("files");
  const files = rawFiles.filter((f): f is File => f instanceof Blob && "name" in f);
  if (files.length === 0) {
    return NextResponse.json({ ok: false, error: "files_required" }, { status: 400 });
  }
  if (files.length > MAX_CHAT_ATTACHMENTS_PER_TURN) {
    return NextResponse.json(
      { ok: false, error: "too_many_files", max_files: MAX_CHAT_ATTACHMENTS_PER_TURN },
      { status: 413 },
    );
  }

  const agentKey = typeof form.get("agent_key") === "string" ? String(form.get("agent_key")) : null;
  const sessionId = typeof form.get("session_id") === "string" ? String(form.get("session_id")) : null;
  const uploaded = [];

  for (const file of files) {
    if (file.size <= 0) {
      return NextResponse.json({ ok: false, error: "empty_file", filename: file.name }, { status: 400 });
    }
    if (file.size > MAX_CHAT_ATTACHMENT_BYTES) {
      return NextResponse.json(
        {
          ok: false,
          error: "file_too_large",
          filename: file.name,
          max_bytes: MAX_CHAT_ATTACHMENT_BYTES,
        },
        { status: 413 },
      );
    }
    const mime = (file.type || mimeFromName(file.name) || "application/octet-stream").toLowerCase();
    if (!CHAT_ATTACHMENT_ALLOWED_MIME.has(mime)) {
      return NextResponse.json(
        { ok: false, error: "unsupported_mime_type", filename: file.name, mime },
        { status: 415 },
      );
    }

    const row = await uploadChatAttachment({
      tenantId: sess.tenantId,
      userId: sess.userId,
      agentKey,
      sessionId,
      filename: file.name,
      mimeType: mime,
      bytes: Buffer.from(await file.arrayBuffer()),
      sizeBytes: file.size,
    });
    uploaded.push(summarizeAttachment(row));
  }

  return NextResponse.json({ ok: true, attachments: uploaded });
}

function mimeFromName(name: string): string | null {
  const lower = name.toLowerCase();
  if (lower.endsWith(".csv")) return "text/csv";
  if (lower.endsWith(".txt")) return "text/plain";
  if (lower.endsWith(".md")) return "text/markdown";
  if (lower.endsWith(".json")) return "application/json";
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".doc")) return "application/msword";
  if (lower.endsWith(".docx")) {
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  }
  if (lower.endsWith(".xls")) return "application/vnd.ms-excel";
  if (lower.endsWith(".xlsx")) {
    return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  }
  return null;
}
