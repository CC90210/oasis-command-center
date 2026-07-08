"use client";

/**
 * LeadDetailDrawer — right-side slide-in drawer for the SunBiz Leads
 * and Applications pages. Mounts when the catch-all tenant page sees
 * `?lead=<uuid>` or `?application=<uuid>` in the URL.
 *
 * Thin overlay wrapper (2026-07 conversations-inbox-v2 extraction): owns the
 * dialog chrome (backdrop + slide-in aside), the URL-driven open/close
 * lifecycle, and the /api/leads/[id]/detail fetch. The actual file UI
 * (header, tabs, footer composers) lives in the presentational
 * `LeadFileBody`, which is shared with the Conversations inbox's inline
 * context panel.
 *
 * Loads the aggregated lead detail from /api/leads/[id]/detail in one
 * round trip; LeadFileBody's tabs render off that single payload.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { X } from "lucide-react";
import { LeadFileBody, resolveTitle } from "./LeadFileBody";
import type { DetailPayload, DocRow } from "./LeadFileBody";

// Re-exported so any other importer of these names from this module keeps
// working unchanged; the canonical definitions now live in LeadFileBody.
export type { DetailPayload, DocRow };

export function LeadDetailDrawer({
  tenantSlug,
  recordId,
  entity,
}: {
  tenantSlug: string;
  recordId: string;
  entity: "lead" | "application";
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [data, setData] = useState<DetailPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);

  const reload = useCallback(async () => {
    const url = `/api/leads/${recordId}/detail${entity === "application" ? "?entity=application" : ""}`;
    try {
      const r = await fetch(url, { credentials: "include", cache: "no-store" });
      const j = await r.json();
      if (j.ok) setData(j as DetailPayload);
    } catch {
      /* keep prior data */
    }
  }, [recordId, entity]);

  const close = useCallback(() => {
    const next = new URLSearchParams(searchParams?.toString() || "");
    next.delete("lead");
    next.delete("application");
    const qs = next.toString();
    router.replace(qs ? `?${qs}` : "?", { scroll: false });
  }, [router, searchParams]);

  // Esc to close + body scroll lock + focus the close button on mount
  // (Codex pass-2 finding from the prior session: drawers without these
  // three a11y affordances trap keyboard users and shift scroll context
  // behind the modal).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeBtnRef.current?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [close]);

  useEffect(() => {
    let alive = true;
    setData(null);
    setError(null);
    const url = `/api/leads/${recordId}/detail${entity === "application" ? "?entity=application" : ""}`;
    fetch(url, { credentials: "include" })
      .then((r) => r.json())
      .then((j) => {
        if (!alive) return;
        if (!j.ok) {
          setError(j.error || "load_failed");
          return;
        }
        setData(j as DetailPayload);
      })
      .catch((e) => {
        if (alive) setError(String(e?.message || e));
      });
    return () => {
      alive = false;
    };
  }, [recordId, entity]);

  const shortId = recordId.slice(0, 8);
  const title = data
    ? resolveTitle(data.record.data, entity, shortId)
    : entity === "application"
      ? `Application ${shortId}`
      : `Lead ${shortId}`;

  return (
    <div
      className="fixed inset-0 z-50 flex"
      role="dialog"
      aria-modal="true"
      aria-label={`${title} detail`}
    >
      <button
        type="button"
        aria-label="Close drawer"
        onClick={close}
        className="flex-1 bg-black/60 backdrop-blur-sm cursor-default"
      />
      <aside className="relative w-full sm:w-[580px] h-full bg-bg-elev border-l border-bg-border shadow-[-12px_0_32px_-8px_rgba(0,0,0,0.6)] flex flex-col">
        {data ? (
          <LeadFileBody
            tenantSlug={tenantSlug}
            leadId={recordId}
            entity={entity}
            record={data.record.data}
            documents={data.documents}
            application={data.application}
            onReload={reload}
            onClose={close}
          />
        ) : (
          <>
            <header className="shrink-0 px-5 py-4 border-b border-bg-border/60">
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <div className="text-[10px] uppercase tracking-[0.12em] text-fg-dim/80 font-semibold mb-1">
                    {entity === "application" ? "Application" : "Merchant"}
                  </div>
                  <h2 className="text-lg font-bold text-fg truncate leading-tight">{title}</h2>
                  <div className="text-[11px] text-fg-dim mt-1 truncate">{shortId}</div>
                </div>
                <button
                  ref={closeBtnRef}
                  type="button"
                  onClick={close}
                  aria-label="Close"
                  className="p-1 rounded-md text-fg-muted hover:text-fg hover:bg-bg-deep transition-colors"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </header>
            <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-5 py-4 text-sm">
              {error && (
                <div className="rounded-md border border-red-500/40 bg-red-500/10 p-3 text-xs text-red-200">
                  Failed to load: {error}
                </div>
              )}
              {!error && (
                <div className="text-xs text-fg-dim italic py-6 text-center">Loading…</div>
              )}
            </div>
          </>
        )}
      </aside>
    </div>
  );
}
