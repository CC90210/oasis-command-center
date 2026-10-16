/**
 * POST /api/forms/[id]/offer/write  { description, audience?, save? }
 *
 * "Write my page" (lib/offer-pages/write-page.ts): the workspace's own AI
 * account drafts the words of this offer's page from the owner's description.
 * Every sentence is vetted first (vetWrittenCopy): one that states a figure,
 * a time frame or a claim the owner did not give is left out. Nothing here
 * publishes: the page still goes public only through Publish and its claims
 * gate.
 *
 * TWO MODES, ONE WRITER EACH.
 * - save (default; New offer, Turn into an offer): the page was just made and
 *   no editor holds it. The route keeps the owner's description in the brief
 *   (saved before the vault read and the model call, so a failed write keeps what they typed),
 *   fills the empty fields and saves the draft. No call is made when nothing
 *   is empty, and an answer that fills nothing is an unusable answer.
 * - save: false (the offer editor's "Write the empty parts"): the route saves
 *   NOTHING and returns the vetted copy. The editor fills the empty fields of
 *   the page it holds and saves through its own autosave, so the draft it is
 *   editing has one writer and no write can race it.
 *
 * WHO: formsSession({ edit: true }), the rule every forms write uses (an owner
 * or admin of the session's own workspace). Same-origin and rate-capped per
 * person: each call spends the workspace's AI budget.
 * MODEL: runToolModelCall (lib/tools/worker/ai.ts), the workspace AI account
 * path every workspace tool uses: its own key, budget cap and usage ledger
 * (surface "offer_pages.write"); never the platform key or the subscription.
 * REDACTION: every typed value (names, description, audience) is scrubbed of
 * configured keys and this workspace's vault values before the model sees it
 * (CLAUDE.md "Redaction is load-bearing"). A vault that can't be read in full
 * sends nothing, as a department turn does (lib/os/desk/turn.ts).
 */
import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { sameOrigin } from "@/lib/calendar/http";
import { fetchTenantVaultSecretsForRedaction } from "@/lib/chat-persistence";
import { formsSession } from "@/lib/forms/access";
import { applyClaimTicks, lintDoc, stampConfirmations } from "@/lib/offer-pages/claims";
import { editableForm, fallbackHeadline } from "@/lib/offer-pages/operator";
import { offerPagesDb, readOfferRow, saveDraft, type OfferRow } from "@/lib/offer-pages/store";
import { OfferPageError, type OfferPageDoc } from "@/lib/offer-pages/types";
import {
  applyWrittenCopy,
  parseWrittenCopy,
  scrubWriteInput,
  withBrief,
  writePageSystemPrompt,
  writePageUserPrompt,
} from "@/lib/offer-pages/write-page";
import { vetWrittenCopy } from "@/lib/offer-pages/write-page-vet";
import { emptyWritableParts, writePageInputProblem } from "@/lib/offer-pages/write-page-client";
import { rateLimit } from "@/lib/rate-limit";
import { redactAll, redactTenantVaultSecrets, type VaultSecret } from "@/lib/secret-redaction";
import { toolErrorLine } from "@/lib/tools/errors";
import { runToolModelCall } from "@/lib/tools/worker/ai";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const json = (body: Record<string, unknown>, status = 200) => NextResponse.json(body, { status });

const UNAVAILABLE = { ok: false, error: "offer_pages_unavailable", message: "Offer pages aren't switched on yet." } as const;

/** A bound on what is read from the body, well above every prompt limit (write-page.ts WRITE_PAGE_LIMITS). */
const RAW_INPUT_CAP = 10_000;

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
  // Read whole (bounded), redacted below, and only then shortened for the
  // prompt (writePageUserPrompt): cutting first could split a secret, and
  // redaction cannot recognise a fragment of one. The saved brief keeps the
  // owner's longer audience (withBrief).
  const description = text(body.description, RAW_INPUT_CAP);
  const audience = text(body.audience, RAW_INPUT_CAP);
  const problem = writePageInputProblem(description);
  if (problem) return json({ ok: false, error: "description_required", message: problem }, 400);
  const save = body.save !== false;

  const db = offerPagesDb();
  if (!db) return json(UNAVAILABLE, 503);
  const form = await editableForm(db, tenantId, id);
  if (!form) return json({ ok: false, error: "not_found" }, 404);
  const read = await readOfferRow(db, tenantId, id);
  if (read.state === "unavailable") return json(UNAVAILABLE, 503);
  if (read.state === "none") {
    return json({ ok: false, error: "offer_page_missing", message: "Make the page first (New offer, or Turn into an offer)." }, 409);
  }
  let current: OfferRow = read.row;
  if (!current.draft) {
    return json({ ok: false, error: "draft_unreadable", message: "This page's draft can't be read, so nothing was written over it." }, 409);
  }
  // A new offer's draft with nothing empty: no paid call. (The editor asks
  // only while the page it holds has empty parts.)
  if (save && emptyWritableParts(current.draft).length === 0) {
    return json({ ok: true, filled: [], message: "Every part of this page already has words, so nothing was changed." });
  }

  /** One draft save, the builder's own way (stamping, claim ticks, compare-and-swap). */
  const saveRow = async (next: OfferPageDoc): Promise<NextResponse | null> => {
    const now = new Date().toISOString();
    const headline = fallbackHeadline(form);
    const draft = stampConfirmations(next, [current.draft, current.published], actor, now);
    const claims = applyClaimTicks({
      existing: current.claims,
      confirm: [],
      unconfirm: [],
      draftHits: lintDoc(draft, { fallbackHeadline: headline }),
      publishedHits: current.published ? lintDoc(current.published, { fallbackHeadline: headline }) : [],
      actor,
      now,
    });
    const saved = await saveDraft(db, { tenantId, formId: id, draft, expectedVersion: current.draftVersion, claims, actor, now });
    if (!saved.ok) {
      if (saved.error === "conflict") {
        return json(
          { ok: false, error: "draft_conflict", current_version: saved.currentVersion, message: "Someone saved this page while it was being written. Reload, then try again." },
          409,
        );
      }
      if (saved.error === "not_found") return json({ ok: false, error: "not_found" }, 404);
      return json(UNAVAILABLE, 503);
    }
    const after = await readOfferRow(db, tenantId, id);
    if (after.state !== "row") return json({ ok: false, error: "not_found" }, 404);
    current = after.row;
    return null;
  };

  // A new offer keeps what the owner typed before anything that can fail (the
  // vault read, the model call), so a failed write still leaves it in the
  // brief for the retry. Configured keys are redacted now (no vault needed);
  // the brief is the owner's own notes, like anything typed in the Copy brief,
  // and every model call that reads it redacts it again. (The editor's
  // description IS the brief it holds, saved by its own autosave.)
  if (save) {
    const briefed = withBrief(current.draft, { description: redactAll(description), audience: redactAll(audience) });
    if (JSON.stringify(briefed.brief ?? null) !== JSON.stringify(current.draft.brief ?? null)) {
      const refused = await saveRow(briefed);
      if (refused) return refused;
    }
  }

  const tenant = await db.execute({ sql: "SELECT name FROM tenants WHERE id = ? LIMIT 1", args: [tenantId] });
  const businessName = String(tenant.rows[0]?.name ?? "").trim() || form.name;

  let vault: VaultSecret[];
  try {
    vault = await fetchTenantVaultSecretsForRedaction(tenantId, { requireComplete: true });
  } catch (err) {
    console.error("[offer-pages.write] vault unreadable; nothing sent to the model", { formId: id, error: redactAll((err as Error).message) });
    return json(
      { ok: false, error: "redaction_unavailable", message: "The page couldn't be written safely just now: your workspace's saved keys couldn't be checked. Try again in a minute." },
      503,
    );
  }
  const input = scrubWriteInput(
    { offerName: form.name, description, audience, businessName, template: current.template },
    (value) => redactTenantVaultSecrets(redactAll(value), vault),
  );

  const call = await runToolModelCall({
    tenantId,
    userId: actor,
    jobId: randomUUID(),
    surface: "offer_pages.write",
    system: writePageSystemPrompt(),
    prompt: writePageUserPrompt(input),
    maxTokens: 3000,
    requestStartedAt,
  });
  if (!call.ok) {
    return json({ ok: false, error: call.code, message: toolErrorLine(call.code, "worker") }, statusFor(call.code));
  }
  const unusable = () => json({ ok: false, error: "ai_unusable_answer", message: toolErrorLine("ai_unusable_answer", "worker") }, 502);
  const written = parseWrittenCopy(call.text);
  if (!written) return unusable();
  const source = [input.businessName, input.offerName, input.description, input.audience ?? ""].join("\n");
  const { copy, withheld } = vetWrittenCopy(written, source);

  if (!save) return json({ ok: true, filled: [], copy, withheld, model: call.model });

  if (!current.draft) return unusable();
  let applied: ReturnType<typeof applyWrittenCopy>;
  try {
    applied = applyWrittenCopy(current.draft, copy);
  } catch (err) {
    if (err instanceof OfferPageError) {
      console.error("[offer-pages.write] the written page did not parse", { formId: id, path: err.path, reason: err.reason });
      return unusable();
    }
    throw err;
  }
  // Parts were empty (checked above), so an answer that fills none is unusable,
  // not a success: the dialog would open an untouched page as written.
  if (applied.filled.length === 0) return unusable();

  const refused = await saveRow(applied.doc);
  if (refused) return refused;
  return json({ ok: true, filled: applied.filled, withheld, model: call.model });
}
