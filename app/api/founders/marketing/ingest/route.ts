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
import { methodNotHere } from "@/lib/founders/method-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** Bounded so one paste cannot enqueue a thousand jobs by accident. */
const MAX_PER_REQUEST = 25;

type QueuedRow = { id: string; source_url: string; state: string };

/** Postgres 23505 unique_violation — the in-flight guard fired. A dedup, not a failure. */
const isUniqueViolation = (err: { code?: string } | null | undefined): boolean =>
  err?.code === "23505";

const notFound = () => NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });

export async function POST(req: Request) {
  const founder = await resolveFounder();
  if (!founder) return notFound();

  let body: { text?: string; urls?: string[]; label?: string; note?: string };
  try {
    const parsed = await req.json();
    // `req.json()` does NOT throw on a literal `null` body — it returns null,
    // and the first property read below then throws a TypeError, turning a
    // malformed request into a 500.
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
    }
    body = parsed as typeof body;
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

  /*
   * Anything over the cap is REPORTED, never silently dropped. Pasting 40 links
   * and being told "25 queued" with no mention of the other 15 is the failure
   * this codebase keeps having: the operator reads it as done and the missing
   * items are only discovered much later, if ever.
   */
  const overCap = Math.max(0, raw.length - MAX_PER_REQUEST);
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
      // The EMAIL, not a display name. Two people use this tab, and the old
      // fallback hardcoded "adon" — so any drop by a profile with no display
      // name set was attributed to the wrong person, permanently and silently.
      contributed_by: founder.email || founder.displayName || "unknown@oasisai.work",
      extraction: t
        ? { source_kind: t.kind, extractor: t.extractor, external_id: t.externalId, inspirable: t.inspirable }
        : {},
      created_at: now,
      updated_at: now,
    };
  });

  const migrationPending = () =>
    NextResponse.json(
      {
        ok: false,
        error: "migration_pending",
        detail:
          "database/133_marketing_hub.sql has not been applied yet, so there is nowhere to store this. Nothing was lost — re-drop these links once it is applied.",
        would_have_queued: accepted,
        over_cap: overCap,
        over_cap_links: overCap ? raw.slice(MAX_PER_REQUEST) : [],
      },
      { status: 503 },
    );

  // The in-flight guard is a PARTIAL unique index (source_url is not null AND
  // state in ('queued','extracting')), and PostgREST's upsert CANNOT target it:
  // onConflict emits a bare ON CONFLICT (tenant_id, source_url) with no WHERE
  // predicate, Postgres refuses to infer a partial index from that, and answers
  // 42P10 for the whole batch. This repo has already paid for that lesson once
  // (the open-tracking dedup outage). The index stays partial on purpose — it is
  // what lets a link be re-ingested after an earlier run finished — so the dedup
  // moves here: ask what is already in flight, then insert only the rest.
  const inFlight = await db
    .from("marketing_corpus")
    .select("source_url")
    .eq("tenant_id", founder.tenantId) // service role bypasses RLS
    .in("source_url", accepted.map((a) => a.url))
    .in("state", ["queued", "extracting"]);

  if (inFlight.error) {
    if (isMissingTableError(inFlight.error)) return migrationPending();
    console.warn("[founders.ingest]", inFlight.error.message);
    return NextResponse.json({ ok: false, error: "insert_failed" }, { status: 500 });
  }

  const busy = new Set((inFlight.data ?? []).map((r) => r.source_url as string));
  const fresh = rows.filter((r) => !busy.has(r.source_url));

  const queued: QueuedRow[] = [];
  if (fresh.length) {
    const ins = await db.from("marketing_corpus").insert(fresh).select("id, source_url, state");
    if (!ins.error) {
      queued.push(...((ins.data ?? []) as QueuedRow[]));
    } else if (isMissingTableError(ins.error)) {
      return migrationPending();
    } else if (isUniqueViolation(ins.error)) {
      // A concurrent paste won the race between the select above and this
      // insert. The index did its job; retry row by row so one collision does
      // not throw away the rest of the batch.
      for (const row of fresh) {
        const one = await db
          .from("marketing_corpus")
          .insert(row)
          .select("id, source_url, state")
          .single();
        if (!one.error) {
          queued.push(one.data as QueuedRow);
        } else if (!isUniqueViolation(one.error)) {
          console.warn("[founders.ingest]", one.error.message);
          return NextResponse.json({ ok: false, error: "insert_failed" }, { status: 500 });
        }
      }
    } else {
      console.warn("[founders.ingest]", ins.error.message);
      return NextResponse.json({ ok: false, error: "insert_failed" }, { status: 500 });
    }
  }

  // Anything accepted but not queued was already in flight.
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
    // Named, not just counted, so the operator can re-drop exactly these.
    over_cap: overCap,
    over_cap_links: overCap ? raw.slice(MAX_PER_REQUEST) : [],
    items: queued,
  });
}

// Verbs this route does not implement answer 404, not the framework's 405.
// A 405 confirms the path is real, which is exactly what lib/founders/gate.ts
// refuses to tell a tenant that is not ours. See lib/founders/method-guard.ts.
export const GET = methodNotHere;
export const PUT = methodNotHere;
export const PATCH = methodNotHere;
export const DELETE = methodNotHere;
