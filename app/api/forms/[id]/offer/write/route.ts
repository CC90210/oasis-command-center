/**
 * POST /api/forms/[id]/offer/write  { description, audience? }
 *
 * "Write my page" (lib/offer-pages/write-page.ts): the workspace's own AI
 * account drafts the words of this offer's page from the owner's description,
 * and the result is saved as the DRAFT. It fills only empty fields, writes no
 * price, result, guarantee or confirmation, and never publishes: the page
 * still goes public only through Publish and its claims gate.
 *
 * WHO: formsSession({ edit: true }), the rule every forms write uses (an owner
 * or admin of the session's own workspace). Same-origin and rate-capped per
 * person: each call spends the workspace's AI budget.
 * MODEL: runToolModelCall (lib/tools/worker/ai.ts), the workspace AI account
 * path every workspace tool uses: its own key, budget cap and usage ledger
 * (surface "offer_pages.write"); never the platform key or the subscription.
 * SAVE: the store's compare-and-swap draft save on the version just read, with
 * the same confirmation stamping and claim ticks as the builder's own save.
 */
import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { sameOrigin } from "@/lib/calendar/http";
import { formsSession } from "@/lib/forms/access";
import { applyClaimTicks, lintDoc, stampConfirmations } from "@/lib/offer-pages/claims";
import { editableForm, fallbackHeadline } from "@/lib/offer-pages/operator";
import { offerPagesDb, readOfferRow, saveDraft } from "@/lib/offer-pages/store";
import { OfferPageError } from "@/lib/offer-pages/types";
import {
  applyWrittenCopy,
  parseWrittenCopy,
  WRITE_PAGE_LIMITS,
  writePageSystemPrompt,
  writePageUserPrompt,
} from "@/lib/offer-pages/write-page";
import { rateLimit } from "@/lib/rate-limit";
import { toolErrorLine } from "@/lib/tools/errors";
import { runToolModelCall } from "@/lib/tools/worker/ai";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const json = (body: Record<string, unknown>, status = 200) => NextResponse.json(body, { status });

/** HTTP status for a model-call refusal: the caller can fix some, wait out others. */
function statusFor(code: string): number {
  if (code === "ai_account_missing") return 412;
  if (code.startsWith("ai_budget") || code === "ai_usage_unavailable") return 402;
  if (code === "ai_rate_limited") return 429;
  if (code === "ai_timeout" || code === "request_timeout") return 504;
  return 502;
}

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const requestStartedAt = new Date();
  if (!sameOrigin(req)) return json({ ok: false, error: "cross_origin_refused" }, 403);
  const auth = await formsSession({ edit: true });
  if (!auth.ok) return auth.response;
  const tenantId = auth.session.tenantId;
  const actor = auth.session.userId;
  const { id } = await ctx.params;

  const limit = rateLimit({ key: `offer-write:${actor}`, capacity: 4, refillPerSec: 1 / 30 });
  if (!limit.allowed) {
    return json({ ok: false, error: "rate_limited", message: "Too many pages written in a row. Wait a minute and try again." }, 429);
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return json({ ok: false, error: "invalid_json" }, 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return json({ ok: false, error: "invalid_json" }, 400);
  const description = text(body.description, WRITE_PAGE_LIMITS.description);
  const audience = text(body.audience, WRITE_PAGE_LIMITS.audience);
  if (description.length < 20) {
    return json(
      { ok: false, error: "description_required", message: "Say in a sentence or two what the offer is and does, so the page can be written from it." },
      400,
    );
  }

  const db = offerPagesDb();
  if (!db) return json({ ok: false, error: "offer_pages_unavailable", message: "Offer pages aren't switched on yet." }, 503);
  const form = await editableForm(db, tenantId, id);
  if (!form) return json({ ok: false, error: "not_found" }, 404);
  const read = await readOfferRow(db, tenantId, id);
  if (read.state === "unavailable") return json({ ok: false, error: "offer_pages_unavailable", message: "Offer pages aren't switched on yet." }, 503);
  if (read.state === "none") {
    return json({ ok: false, error: "offer_page_missing", message: "Make the page first (New offer, or Turn into an offer)." }, 409);
  }
  const row = read.row;
  if (!row.draft) {
    return json({ ok: false, error: "draft_unreadable", message: "This page's draft can't be read, so nothing was written over it." }, 409);
  }

  const tenant = await db.execute({ sql: "SELECT name FROM tenants WHERE id = ? LIMIT 1", args: [tenantId] });
  const businessName = String(tenant.rows[0]?.name ?? "").trim() || form.name;

  const call = await runToolModelCall({
    tenantId,
    userId: actor,
    jobId: randomUUID(),
    surface: "offer_pages.write",
    system: writePageSystemPrompt(),
    prompt: writePageUserPrompt({ offerName: form.name, description, audience, businessName, template: row.template }),
    maxTokens: 3000,
    requestStartedAt,
  });
  if (!call.ok) {
    return json({ ok: false, error: call.code, message: toolErrorLine(call.code, "worker") }, statusFor(call.code));
  }
  const written = parseWrittenCopy(call.text);
  if (!written) {
    return json({ ok: false, error: "ai_unusable_answer", message: toolErrorLine("ai_unusable_answer", "worker") }, 502);
  }

  let applied: ReturnType<typeof applyWrittenCopy>;
  try {
    applied = applyWrittenCopy(row.draft, written, { description, audience });
  } catch (err) {
    if (err instanceof OfferPageError) {
      console.error("[offer-pages.write] the written page did not parse", { formId: id, path: err.path, reason: err.reason });
      return json({ ok: false, error: "ai_unusable_answer", message: toolErrorLine("ai_unusable_answer", "worker") }, 502);
    }
    throw err;
  }
  if (applied.filled.length === 0) {
    return json({
      ok: true,
      version: row.draftVersion,
      filled: [],
      message: "Every part of this page already has words, so nothing was changed.",
    });
  }

  const now = new Date().toISOString();
  const headline = fallbackHeadline(form);
  const draft = stampConfirmations(applied.doc, [row.draft, row.published], actor, now);
  const claims = applyClaimTicks({
    existing: row.claims,
    confirm: [],
    unconfirm: [],
    draftHits: lintDoc(draft, { fallbackHeadline: headline }),
    publishedHits: row.published ? lintDoc(row.published, { fallbackHeadline: headline }) : [],
    actor,
    now,
  });
  const saved = await saveDraft(db, { tenantId, formId: id, draft, expectedVersion: row.draftVersion, claims, actor, now });
  if (!saved.ok) {
    if (saved.error === "conflict") {
      return json(
        { ok: false, error: "draft_conflict", current_version: saved.currentVersion, message: "Someone saved this page while it was being written. Reload, then try again." },
        409,
      );
    }
    if (saved.error === "not_found") return json({ ok: false, error: "not_found" }, 404);
    return json({ ok: false, error: "offer_pages_unavailable", message: "Offer pages aren't switched on yet." }, 503);
  }
  return json({ ok: true, version: saved.version, filled: applied.filled, model: call.model });
}
