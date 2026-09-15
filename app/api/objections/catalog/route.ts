/**
 * The objection library, and the door new objections come in through.
 *
 * GET  — every objection in the tenant, in every status, with its answers.
 * POST — one new DRAFT objection, or a batch of them from a paste.
 *
 * WHAT THIS IS NOT: it is not the route the battle card calls. That is
 * `/api/web-leads/[id]/objections`, it reads approved rows only, and it is
 * ranked per lead. Nothing here can widen what a rep is shown mid-call, which
 * is deliberate: authoring and serving are separate blast radii.
 *
 * EVERY QUERY IS TENANT-PINNED inside lib/web-leads/objections/admin.ts, and
 * every gate here fails closed. A POST creates drafts and only drafts; there
 * is no parameter that creates an approved row, because a gate with a bypass
 * parameter is not a gate.
 */

import { NextResponse, type NextRequest } from "next/server";

import { resolveSessionContext } from "@/lib/api-auth";
import {
  mayAuthorObjections,
  mayViewObjectionLibrary,
} from "@/lib/web-leads/objections/admin-access";
import {
  ObjectionAdminError,
  ObjectionRejected,
  createDraftObjection,
  fetchAdminCatalog,
  fetchMatchIndex,
  findDuplicate,
  parseBatch,
  type DraftInput,
} from "@/lib/web-leads/objections/admin";
import { isObjectionFamily, isWebsitePremise } from "@/lib/web-leads/objections/types";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await resolveSessionContext();
  if (!mayViewObjectionLibrary(session)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  try {
    const objections = await fetchAdminCatalog();
    return NextResponse.json({ objections });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown";
    console.error("[objections/catalog] read failed", message);
    return NextResponse.json({ error: "read_failed" }, { status: 500 });
  }
}

/** One loose shape rather than a union of a batch body and a single body. An
 *  intersection of the two collapses to `never`, because their `mode` literals
 *  conflict, and every field read off it then fails to compile. Each field is
 *  narrowed at the point it is used instead. */
type PostBody = Record<string, unknown>;

/**
 * A batch paste is a DRY RUN by design: it returns what it parsed and what
 * each line looks like a duplicate of, and writes nothing.
 *
 * The person pasting is the only one who can tell a genuine new objection from
 * a reworded existing one, and they cannot tell from the textarea. Writing
 * first and asking afterwards produces exactly the bloated library this
 * feature exists to prevent, so the batch path deliberately cannot write:
 * each line comes back as a candidate and is created, or not, one at a time.
 */
async function previewBatch(text: string) {
  const lines = parseBatch(text);
  const existing = await fetchMatchIndex();
  const seenInPaste: { id: string; slug: string; says: string; status: string }[] = [];

  const candidates = lines.map((says) => {
    // Checked against the library AND against earlier lines of this same
    // paste, so two rewordings inside one block are caught before either is
    // written rather than after both are.
    const verdict = findDuplicate(says, [...existing, ...seenInPaste]);
    seenInPaste.push({ id: `paste:${seenInPaste.length}`, slug: "", says, status: "pasted" });
    return { says, duplicate: verdict };
  });

  return { parsed: candidates.length, candidates };
}

export async function POST(req: NextRequest) {
  const session = await resolveSessionContext();
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

  const payload = body as PostBody;

  if (payload.mode === "batch") {
    if (typeof payload.text !== "string" || payload.text.trim().length === 0) {
      return NextResponse.json({ error: "empty_paste" }, { status: 400 });
    }
    try {
      return NextResponse.json(await previewBatch(payload.text));
    } catch (err) {
      console.error("[objections/catalog] batch preview failed", err instanceof Error ? err.message : "unknown");
      return NextResponse.json({ error: "read_failed" }, { status: 500 });
    }
  }

  const says = typeof payload.says === "string" ? payload.says : "";
  const meaning = typeof payload.meaning === "string" ? payload.meaning : "";
  const prevent = typeof payload.prevent === "string" ? payload.prevent : "";
  const family = payload.family;
  const premise = payload.websitePremise;

  if (!isObjectionFamily(family)) {
    return NextResponse.json({ error: "bad_family", message: "Pick one of the six families." }, { status: 400 });
  }

  const input: DraftInput = {
    says,
    meaning,
    prevent,
    family,
    websitePremise: isWebsitePremise(premise) ? premise : null,
    source: typeof payload.source === "string" ? payload.source : null,
  };

  // `session` is authorized past the gate above, so these are present.
  const authed = session as Extract<typeof session, { ok: true }>;
  const author = authed.email?.trim() || authed.userId;

  try {
    const created = await createDraftObjection(input, author);
    return NextResponse.json({ ok: true, ...created, status: "draft" }, { status: 201 });
  } catch (err) {
    if (err instanceof ObjectionRejected) {
      return NextResponse.json({ error: err.reason, message: err.message }, { status: 409 });
    }
    if (err instanceof ObjectionAdminError) {
      console.error("[objections/catalog] create failed", err.message);
      return NextResponse.json({ error: "write_failed" }, { status: 500 });
    }
    console.error("[objections/catalog] create failed", err instanceof Error ? err.message : "unknown");
    return NextResponse.json({ error: "write_failed" }, { status: 500 });
  }
}
