"use client";

/**
 * ObjectionConsole — fetches GET /api/web-leads/[id]/objections for one lead
 * and renders the result as ObjectionCards. Replaces the static half of
 * ObjectionPanel.tsx (deleted in the next task), which rendered the same
 * eight brush-offs from a hardcoded table on every lead. This renders
 * whatever lib/web-leads/objections/ranking.ts ranked for THIS lead, in the
 * order the server sent it — no client-side re-sorting.
 *
 * `bare` behaves exactly as it did on ObjectionPanel: the caller's
 * BattleSection supplies the outer shell, heading and collapse control, and
 * this renders only its own content so the two modes stay byte-identical.
 *
 * Each card is keyed `${leadId}:${objection.id}`, not just `objection.id`.
 * The same catalog entry can appear in two different leads' ranked lists, and
 * without the leadId in the key React would reuse that ObjectionCard
 * instance across a lead switch instead of unmounting it — exactly the stale-
 * write race CallOutcomeLog's docblock warns about, and the one ObjectionCard
 * leans on this key to rule out entirely (see its own docblock).
 *
 * THREE EXPLICIT STATES, never a blank section: loading renders skeletons
 * shaped like the cards (the same convention as CallOutcomeLog's
 * HistorySkeleton); an empty catalog names where objections get added
 * without pretending /objections is a working link, because that Phase 2
 * page does not exist yet; a read failure renders a plain sentence plus a
 * retry control. A rep mid-call must be able to tell "nothing to show" from
 * "this is broken" without guessing.
 */

import { useEffect, useState } from "react";
import { ObjectionCard } from "./ObjectionCard";
import type { CatalogObjection, ObjectionEventRecord } from "@/lib/web-leads/objections/types";

type ConsoleState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | {
      status: "ready";
      objections: CatalogObjection[];
      events: ObjectionEventRecord[];
      canMutate: boolean;
      openCount: number;
    };

const LOAD_FAILED = "Could not load the objection library.";

function CardSkeleton({ delay }: { delay: number }) {
  return (
    <li
      className="h-40 rounded-lg border border-bg-border bg-bg-raised/40 animate-pulse-slow"
      style={{ animationDelay: `${delay}ms` }}
    />
  );
}

export function ObjectionConsole({ leadId, bare = false }: { leadId: string; bare?: boolean }) {
  const [state, setState] = useState<ConsoleState>({ status: "loading" });
  const [expanded, setExpanded] = useState(false);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let alive = true;
    setState({ status: "loading" });
    setExpanded(false);
    fetch(`/api/web-leads/${encodeURIComponent(leadId)}/objections`)
      .then(async (r) => {
        if (!r.ok) {
          if (alive) setState({ status: "error", message: LOAD_FAILED });
          return;
        }
        const responseBody = await r.json();
        // Read AFTER the body parse, the same pattern CallOutcomeLog and
        // WebsiteComparison use, so a slow response for lead A can never land
        // after a faster response for lead B and overwrite it.
        if (!alive) return;
        if (!responseBody?.ok) {
          setState({ status: "error", message: LOAD_FAILED });
          return;
        }
        setState({
          status: "ready",
          objections: (responseBody.objections || []) as CatalogObjection[],
          events: (responseBody.events || []) as ObjectionEventRecord[],
          canMutate: responseBody.canMutate === true,
          openCount: typeof responseBody.openCount === "number" ? responseBody.openCount : 5,
        });
      })
      .catch(() => {
        if (alive) setState({ status: "error", message: LOAD_FAILED });
      });
    return () => {
      alive = false;
    };
  }, [leadId, nonce]);

  let body: React.ReactNode;

  if (state.status === "loading") {
    body = (
      <ul className="mt-5 grid gap-4 md:grid-cols-2" aria-busy="true" aria-live="polite">
        {[0, 1, 2, 3].map((i) => (
          <CardSkeleton key={i} delay={i * 60} />
        ))}
      </ul>
    );
  } else if (state.status === "error") {
    const error = state.message;
    // The `{error}` node below is the repo's shared fetch-failure banner
    // convention (see BattleCard.tsx's own note on why its className stays a
    // static string): it is what the colour-ban test's one carve-out matches,
    // and it fires before any objection content exists, so it is not a
    // judgement about an objection.
    body = (
      <div className="mt-5">
        <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-200">{error}</p>
        <button
          type="button"
          onClick={() => setNonce((n) => n + 1)}
          className="mt-3 rounded-lg border border-accent/40 px-4 py-2 text-xs font-semibold text-fg transition-[color,border-color,box-shadow] hover:border-accent/70 hover:shadow-glow focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/70 motion-reduce:transition-none"
        >
          Try again
        </button>
      </div>
    );
  } else if (state.objections.length === 0) {
    // The fresh-tenant state, not an error: nothing has been approved into
    // the catalog yet. /objections is where that happens, but it is a Phase 2
    // page that does not exist yet, so this names it rather than linking it.
    body = (
      <p className="mt-5 max-w-2xl text-sm leading-relaxed text-fg-dim">
        No objections in the library yet. They get added from /objections once that page ships.
      </p>
    );
  } else {
    const events = state.events;
    const eventFor = (objectionId: string) => events.find((e) => e.objectionId === objectionId) ?? null;
    const visible = expanded ? state.objections : state.objections.slice(0, state.openCount);
    const remaining = state.objections.length - visible.length;
    body = (
      <>
        <ul className="mt-5 grid gap-4 md:grid-cols-2">
          {visible.map((o) => (
            <ObjectionCard
              key={`${leadId}:${o.id}`}
              leadId={leadId}
              objection={o}
              existingEvent={eventFor(o.id)}
              canMutate={state.canMutate}
            />
          ))}
        </ul>
        {remaining > 0 && (
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="mt-4 rounded-full border border-bg-border px-3 py-1 text-[11px] font-semibold text-fg-dim transition-[color,border-color,box-shadow] hover:border-accent/40 hover:text-fg hover:shadow-glow focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/70 motion-reduce:transition-none"
          >
            Show all {state.objections.length}
          </button>
        )}
      </>
    );
  }

  if (bare) return <>{body}</>;

  return (
    <section className="rounded-xl border border-bg-border bg-bg-panel p-5 lg:p-6">
      <h2 className="text-[10px] font-bold uppercase tracking-[0.16em] text-fg-muted [font-family:var(--battle-display)]">
        Objections, ranked for this lead
      </h2>
      {body}
    </section>
  );
}

export default ObjectionConsole;
