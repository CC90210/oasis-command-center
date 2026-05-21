import { NextRequest, NextResponse } from "next/server";
import { resolveSessionContext } from "@/lib/api-auth";
import { completeChatAttachmentUpload, summarizeAttachment } from "@/lib/chat-attachments";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
  const completionToken =
    typeof payload?.completion_token === "string" ? payload.completion_token : "";
  if (!completionToken) {
    return NextResponse.json({ ok: false, error: "completion_token_required" }, { status: 400 });
  }

  try {
    const row = await completeChatAttachmentUpload({
      tenantId: sess.tenantId,
      userId: sess.userId,
      completionToken,
      parser: typeof payload?.parser === "string" ? payload.parser : null,
      textExcerpt: typeof payload?.text_excerpt === "string" ? payload.text_excerpt : null,
      truncated: typeof payload?.truncated === "boolean" ? payload.truncated : null,
    });
    return NextResponse.json({ ok: true, attachment: summarizeAttachment(row) });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "attachment_complete_failed" },
      { status: 400 },
    );
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
