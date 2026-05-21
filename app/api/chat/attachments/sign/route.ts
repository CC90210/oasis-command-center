import { NextRequest, NextResponse } from "next/server";
import { resolveSessionContext } from "@/lib/api-auth";
import {
  createChatAttachmentSignedUpload,
  MAX_CHAT_ATTACHMENTS_PER_TURN,
} from "@/lib/chat-attachments";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type FileIntent = {
  filename?: unknown;
  mime_type?: unknown;
  size_bytes?: unknown;
};

export async function POST(req: NextRequest) {
  const sess = await resolveSessionContext();
  if (!sess.ok) {
    return NextResponse.json({ ok: false, error: sess.reason }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "expected_json" }, { status: 400 });
  }

  const payload = asRecord(body);
  const files = Array.isArray(payload?.files) ? payload.files : [];
  if (files.length === 0) {
    return NextResponse.json({ ok: false, error: "files_required" }, { status: 400 });
  }
  if (files.length > MAX_CHAT_ATTACHMENTS_PER_TURN) {
    return NextResponse.json(
      { ok: false, error: "too_many_files", max_files: MAX_CHAT_ATTACHMENTS_PER_TURN },
      { status: 413 },
    );
  }

  const agentKey = typeof payload?.agent_key === "string" ? payload.agent_key : null;
  const sessionId = typeof payload?.session_id === "string" ? payload.session_id : null;

  try {
    const uploads = await Promise.all(
      files.map((raw) => {
        const file = asRecord(raw) as FileIntent | null;
        const filename = typeof file?.filename === "string" ? file.filename.trim() : "";
        if (!filename) throw new Error("filename_required");
        return createChatAttachmentSignedUpload({
          tenantId: sess.tenantId,
          userId: sess.userId,
          agentKey,
          sessionId,
          filename,
          mimeType: typeof file?.mime_type === "string" ? file.mime_type : null,
          sizeBytes: typeof file?.size_bytes === "number" ? file.size_bytes : Number(file?.size_bytes || 0),
        });
      }),
    );
    return NextResponse.json({ ok: true, uploads });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "signed_upload_failed" },
      { status: 400 },
    );
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
