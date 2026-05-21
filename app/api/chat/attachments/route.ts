import { NextRequest, NextResponse } from "next/server";
import { resolveSessionContext } from "@/lib/api-auth";
import {
  MAX_CHAT_ATTACHMENTS_PER_TURN,
  normalizeAttachmentMimeType,
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
    const mime = normalizeAttachmentMimeType(file.name, file.type);

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
