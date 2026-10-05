/**
 * Edit, approve, retire: one objection and its answers.
 *
 * PATCH with `{ objection: {...} }`  edits or changes the status of the objection.
 * PATCH with `{ response: {...} }`   edits, approves, retires or promotes one answer.
 * POST  with `{ label, body, posture }` adds a new DRAFT answer.
 *
 * THE APPROVAL GATE LIVES HERE, because this is where the session is. Editing
 * a draft needs authoring rights; moving anything to `approved`, retiring it,
 * or choosing the default a rep sees first needs `mayQuoteAndClose`. The
 * split is the point: a rep may improve wording that nobody has blessed, and
 * only a closer may bless it.
 *
 * Both gates fail closed, and the status check is made BEFORE the body is
 * trusted for anything, so a payload cannot smuggle an approval through a
 * route that only checked the authoring bar.
 */

import { NextResponse, type NextRequest } from "next/server";

import { resolveSessionContext } from "@/lib/api-auth";
import {
  approverName,
  mayApproveObjections,
  mayAuthorObjections,
  needsApprovalRights,
} from "@/lib/web-leads/objections/admin-access";
import {
  ObjectionAdminError,
  ObjectionRejected,
  createDraftResponse,
  fetchEditTargetStatus,
  updateObjection,
  updateResponse,
  type ObjectionPatch,
  type ResponsePatch,
} from "@/lib/web-leads/objections/admin";
import { isObjectionFamily, isObjectionPosture, isWebsitePremise } from "@/lib/web-leads/objections/types";

export const dynamic = "force-dynamic";

const STATUSES = ["draft", "approved", "retired"] as const;
type Status = (typeof STATUSES)[number];
const isStatus = (v: unknown): v is Status => typeof v === "string" && (STATUSES as readonly string[]).includes(v);

function errorResponse(err: unknown, where: string) {
  if (err instanceof ObjectionRejected) {
    return NextResponse.json({ error: err.reason, message: err.message }, { status: 409 });
  }
  console.error(`[objections/catalog/:id] ${where} failed`, err instanceof Error ? err.message : "unknown");
  if (err instanceof ObjectionAdminError) {
    return NextResponse.json({ error: "write_failed" }, { status: 500 });
  }
  return NextResponse.json({ error: "write_failed" }, { status: 500 });
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const [session, { id }] = await Promise.all([resolveSessionContext(), ctx.params]);
  if (!mayAuthorObjections(session)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "bad_body" }, { status: 400 });
  }
  const payload = body as { objection?: Record<string, unknown>; response?: Record<string, unknown> };

  const objectionPatch: ObjectionPatch = {};
  if (payload.objection) {
    const o = payload.objection;
    if (typeof o.says === "string") objectionPatch.says = o.says;
    if (typeof o.meaning === "string") objectionPatch.meaning = o.meaning;
    if (typeof o.prevent === "string") objectionPatch.prevent = o.prevent;
    if (o.family !== undefined) {
      if (!isObjectionFamily(o.family)) {
        return NextResponse.json({ error: "bad_family", message: "Pick one of the six families." }, { status: 400 });
      }
      objectionPatch.family = o.family;
    }
    if (o.websitePremise !== undefined) {
      objectionPatch.websitePremise = isWebsitePremise(o.websitePremise) ? o.websitePremise : null;
    }
    if (o.status !== undefined) {
      if (!isStatus(o.status)) return NextResponse.json({ error: "bad_status" }, { status: 400 });
      objectionPatch.status = o.status;
    }
  }

  const responsePatch: ResponsePatch = {};
  let responseId = "";
  if (payload.response) {
    const r = payload.response;
    if (typeof r.id !== "string" || r.id.length === 0) {
      return NextResponse.json({ error: "missing_response_id" }, { status: 400 });
    }
    responseId = r.id;
    if (typeof r.label === "string") responsePatch.label = r.label;
    if (typeof r.body === "string") responsePatch.body = r.body;
    if (r.status !== undefined) {
      if (!isStatus(r.status)) return NextResponse.json({ error: "bad_status" }, { status: 400 });
      responsePatch.status = r.status;
    }
    if (r.makeDefault === true) responsePatch.makeDefault = true;
  }

  const touchesObjection = Object.keys(objectionPatch).length > 0;
  const touchesResponse = responseId.length > 0 && Object.keys(responsePatch).length > 0;
  if (!touchesObjection && !touchesResponse) {
    return NextResponse.json({ error: "nothing_to_do" }, { status: 400 });
  }

  // Read the stored statuses BEFORE deciding permission. Editing copy that is
  // already live is a closer act, and only the database knows whether it is.
  let stored: { objectionStatus: string | null; responseStatus: string | null };
  try {
    stored = await fetchEditTargetStatus(id, responseId || undefined);
  } catch (err) {
    console.error("[objections/catalog/:id] status read failed", err instanceof Error ? err.message : "unknown");
    return NextResponse.json({ error: "read_failed" }, { status: 500 });
  }

  if (needsApprovalRights(objectionPatch, responsePatch, stored) && !mayApproveObjections(session)) {
    return NextResponse.json(
      {
        error: "approval_forbidden",
        message:
          "Approving, retiring, changing the default answer, or editing wording that is already live needs deal-closing rights.",
      },
      { status: 403 },
    );
  }

  const authed = session as Extract<typeof session, { ok: true }>;
  const approver = mayApproveObjections(session) ? approverName(authed) : null;

  try {
    // The status each write is conditioned on is the one this request was
    // AUTHORIZED against, passed down so the write cannot land on a row that
    // changed status in between. Without it the permission decision and the
    // write are two separate moments, and a closer approving in the gap turns
    // an allowed draft edit into an unapproved edit of live copy.
    if (touchesObjection) await updateObjection(id, objectionPatch, approver, stored.objectionStatus);
    if (touchesResponse) await updateResponse(responseId, id, responsePatch, approver, stored.responseStatus);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err, "patch");
  }
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const [session, { id }] = await Promise.all([resolveSessionContext(), ctx.params]);
  if (!mayAuthorObjections(session)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }
  const payload = (body ?? {}) as Record<string, unknown>;
  const label = typeof payload.label === "string" ? payload.label : "";
  const text = typeof payload.body === "string" ? payload.body : "";
  const posture = payload.posture;

  if (!isObjectionPosture(posture)) {
    return NextResponse.json({ error: "bad_posture", message: "Pick one of the four moves." }, { status: 400 });
  }

  try {
    const created = await createDraftResponse(id, { label, body: text, posture });
    return NextResponse.json({ ok: true, ...created, status: "draft" }, { status: 201 });
  } catch (err) {
    return errorResponse(err, "create response");
  }
}
