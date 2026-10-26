/**
 * POST /api/ai-audit/[engagementId]/transcript — add a discovery call's
 * transcript, pasted or uploaded (.txt, .vtt, .srt), with the client's consent.
 * GET  /api/ai-audit/[engagementId]/transcript?id=... — one transcript's stored
 * lines, for the viewer CC reads before Gate 1.
 *
 * Body: { text, filename?, source: "paste" | "upload", consent_recording, consent_ai }
 *
 * Whoever adds it ticks the consent for a call held outside Oasis Meet: they
 * are attesting that the client agreed, and the row records who and when
 * (consent_basis "owner_attested" for the workspace owner, "founder_attested"
 * for another founder, which Gate 1's card then says). No recording consent,
 * no transcript. Possible passwords and account details are taken out before
 * anything is stored (lib/ai-audit/transcript.ts), and the answer says how
 * many, so the screen can tell CC to set access up through Connections and to
 * read the stored lines.
 *
 * Founders of OASIS's own workspaces only (lib/ai-audit/access.ts). The body is
 * read with a hard cap: a transcript is at most TRANSCRIPT_MAX_BYTES of text.
 */
import { NextResponse, type NextRequest } from "next/server";
import { requireAiAuditSession } from "@/lib/ai-audit/access";
import { parseTranscriptText, TRANSCRIPT_MAX_BYTES } from "@/lib/ai-audit/transcript";
import { addTranscript, getTranscript } from "@/lib/ai-audit/transcripts";
import { getEngagement } from "@/lib/ai-audit/store";
import { withdrawAuthorizationIfStale } from "@/lib/ai-audit/authorize";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

type Ctx = { params: Promise<{ engagementId: string }> };
const NO_STORE = { "cache-control": "no-store" };
/** JSON escaping can double the text; a little room for the other fields. */
const BODY_MAX_BYTES = TRANSCRIPT_MAX_BYTES * 2 + 16_000;

function json(status: number, body: Record<string, unknown>) {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

async function readCapped(req: NextRequest): Promise<string | null> {
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > BODY_MAX_BYTES) return null;
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > BODY_MAX_BYTES) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks.map((c) => Buffer.from(c))));
}

export async function GET(req: NextRequest, ctx: Ctx) {
  const access = await requireAiAuditSession();
  if (!access.ok) return access.response;
  const s = access.session;
  const { engagementId } = await ctx.params;
  const id = req.nextUrl.searchParams.get("id") ?? "";
  const t = id ? await getTranscript(s.db, s.tenantId, id, true) : null;
  if (!t || t.engagement_id !== engagementId) return json(404, { ok: false, error: "not_found" });
  return json(200, {
    ok: true,
    transcript: {
      id: t.id,
      status: t.status,
      format: t.format,
      filename: t.filename,
      redactions: t.redactions,
      consent_ai: t.consent_ai,
      consent_basis: t.consent_basis,
      consent_at: t.consent_at,
      lines: t.lines ?? [],
    },
  });
}

export async function POST(req: NextRequest, ctx: Ctx) {
  const access = await requireAiAuditSession();
  if (!access.ok) return access.response;
  const s = access.session;
  const { engagementId } = await ctx.params;
  const raw = await readCapped(req);
  if (raw === null) return json(413, { ok: false, error: "transcript_too_large" });
  let body: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    body = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    body = null;
  }
  if (!body) return json(400, { ok: false, error: "body_invalid" });
  const engagement = await getEngagement(s.db, s.tenantId, engagementId);
  if (!engagement) return json(404, { ok: false, error: "not_found" });
  if (body.consent_recording !== true) return json(400, { ok: false, error: "no_recording_consent" });
  if (typeof body.consent_ai !== "boolean") return json(400, { ok: false, error: "consent_ai_required" });
  const source = body.source === "upload" ? "upload" : "paste";
  const filename = source === "upload" && typeof body.filename === "string" ? body.filename.trim().slice(0, 200) : null;
  if (source === "upload" && !filename) return json(400, { ok: false, error: "filename_required" });
  const parsed = parseTranscriptText(typeof body.text === "string" ? body.text : "", filename);
  if (!parsed.ok) return json(400, { ok: false, error: `transcript_${parsed.error}` });
  const now = new Date();
  const actor = { type: "user" as const, id: s.userId };
  const r = await addTranscript(s.db, {
    tenantId: s.tenantId,
    engagementId,
    parsed: parsed.value,
    source,
    filename,
    consent: { recording: true, ai: body.consent_ai, basis: s.isOwner ? "owner_attested" : "founder_attested", by: s.userId },
    actor,
    now,
  });
  if (!r.ok) return json(409, { ok: false, error: r.error });
  if (!r.duplicate) await withdrawAuthorizationIfStale(s.db, s.tenantId, engagementId, actor, now);
  return json(200, {
    ok: true,
    duplicate: r.duplicate,
    transcript: { id: r.transcript.id, lines: r.transcript.line_count, speakers: r.transcript.speakers, redactions: r.transcript.redactions, format: r.transcript.format },
  });
}
