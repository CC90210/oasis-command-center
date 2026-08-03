/**
 * POST /api/founders/marketing/ingest — drop links in, queue them for learning.
 *
 * FOUNDERS ONLY. Returns 404 (never 403) to anyone else, same as the pages:
 * a 403 would confirm the route exists.
 *
 * This route does NOT fetch anything. It parses, canonicalises and enqueues.
 * The actual extraction (transcript, repo read, article text) is asynchronous
 * and belongs to a worker — a route that tried to transcribe a video inline
 * would blow maxDuration and lose the work on timeout.
 */

import { NextResponse } from "next/server";
import { getServiceSupabase } from "@/lib/supabase-server";
import { isMissingTableError } from "@/lib/api-helpers";
import { resolveFounder } from "@/lib/founders/gate";
import {
  CORPUS_LABELS,
  extractUrls,
  parseIngestUrl,
  type CorpusLabel,
} from "@/lib/founders/ingest-core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** Bounded so one paste cannot enqueue a thousand jobs by accident. */
const MAX_PER_REQUEST = 25;

const notFound = () => NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });

export async function POST(req: Request) {
  const founder = await resolveFounder();
  if (!founder) return notFound();

  let body: { text?: string; urls?: string[]; label?: string; note?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  const label: CorpusLabel = (CORPUS_LABELS as readonly string[]).includes(body.label || "")
    ? (body.label as CorpusLabel)
    : "neutral";

  // Accept either an explicit list or a blob the operator pasted.
  const raw = [
    ...(Array.isArray(body.urls) ? body.urls : []),
    ...extractUrls(body.text || ""),
  ];
  if (!raw.length) {
    return NextResponse.json({ ok: false, error: "no_links_found" }, { status: 400 });
  }

  const accepted: Array<{ url: string; kind: string; label: string }> = [];
  const rejected: Array<{ url: string; reason: string }> = [];
  const seen = new Set<string>();

  for (const r of raw.slice(0, MAX_PER_REQUEST)) {
    const parsed = parseIngestUrl(r);
    if (!parsed.ok) {
      rejected.push({ url: r, reason: parsed.reason });
      continue;
    }
    // Collapse duplicates within this request before touching the DB; the
    // partial unique index handles cross-request races.
    if (seen.has(parsed.target.canonicalUrl)) continue;
    seen.add(parsed.target.canonicalUrl);
    accepted.push({
      url: parsed.target.canonicalUrl,
      kind: parsed.target.kind,
      label: parsed.target.label,
    });
  }

  if (!accepted.length) {
    return NextResponse.json({ ok: false, error: "nothing_parseable", rejected }, { status: 400 });
  }

  const db = getServiceSupabase();
  const now = new Date().toISOString();
  const rows = accepted.map((a) => {
    const parsed = parseIngestUrl(a.url);
    const t = parsed.ok ? parsed.target : null;
    return {
      tenant_id: founder.tenantId, // scoped explicitly — service role bypasses RLS
      kind: "link",
      label,
      title: a.label,
      source_url: a.url,
      state: "queued",
      contributed_by: founder.displayName || "adon",
      extraction: t
        ? { source_kind: t.kind, extractor: t.extractor, external_id: t.externalId, inspirable: t.inspirable }
        : {},
      created_at: now,
      updated_at: now,
    };
  });

  // ignoreDuplicates: a link already queued or extracting hits the partial
  // unique index. That is a no-op, not an error — re-pasting something is a
  // normal thing to do and should not look like a failure.
  const ins = await db
    .from("marketing_corpus")
    .upsert(rows, { onConflict: "tenant_id,source_url", ignoreDuplicates: true })
    .select("id, source_url, state");

  if (ins.error) {
    if (isMissingTableError(ins.error)) {
      return NextResponse.json(
        {
          ok: false,
          error: "migration_pending",
          detail:
            "database/133_marketing_hub.sql has not been applied yet, so there is nowhere to store this. Nothing was lost — re-drop these links once it is applied.",
          would_have_queued: accepted,
        },
        { status: 503 },
      );
    }
    console.warn("[founders.ingest]", ins.error.message);
    return NextResponse.json({ ok: false, error: "insert_failed" }, { status: 500 });
  }

  const queued = ins.data ?? [];
  // Anything accepted but not returned was already in flight.
  const duplicates = accepted.length - queued.length;

  await db
    .from("marketing_event")
    .insert({
      tenant_id: founder.tenantId,
      actor: founder.displayName || "adon",
      verb: "ingested",
      detail: `${queued.length} link(s) queued as ${label}${duplicates ? `, ${duplicates} already in flight` : ""}`,
    })
    .then(
      () => {},
      () => {}, // audit is best-effort; never fail the ingest on it
    );

  return NextResponse.json({
    ok: true,
    queued: queued.length,
    duplicates,
    rejected,
    items: queued,
  });
}
