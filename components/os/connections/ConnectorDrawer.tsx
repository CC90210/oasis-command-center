"use client";

/**
 * ConnectorDrawer — the detail sheet for one app in the Connections hub.
 *
 * Says, in plain English, what OASIS reads and does with the app, which
 * departments depend on it, and its status in the same words as the card. A
 * coming-soon app opens here instead of a connect flow; a live one also offers
 * its connect action at the bottom — except a pasted-key app (Stripe), whose
 * key form, Test again and Disconnect sit in KeyConnectionPanel right under
 * the status.
 *
 * An overlay, so it is the one place in the hub that carries a shadow (a
 * y-offset, neutral tint). Motion is opacity + transform at 140ms and switches
 * off under prefers-reduced-motion. Esc and the backdrop close it; focus moves
 * to the close button on open, Tab and Shift+Tab stay inside it while it is
 * open, and focus goes back to whatever opened it on close.
 */

import { useEffect, useRef } from "react";
import { X } from "lucide-react";
import { ConnectorIcon, SubProductIcon } from "@/components/os/connections/ConnectorIcon";
import { KeyConnectionPanel } from "@/components/os/connections/KeyConnectionPanel";
import { StatusLine } from "@/components/os/connections/StatusLine";
import { FOCUSABLE_SELECTOR, trapTab } from "@/components/os/connections/focus-trap";
import { glyphColor, type ConnectorDef, type ConnectorStatus } from "@/lib/os/connectors";
import { providerById } from "@/lib/connections/registry";
import { OS_DEPARTMENTS } from "@/lib/os/departments";

function departmentLabel(key: string): string {
  return OS_DEPARTMENTS.find((d) => d.key === key)?.label ?? key;
}

export function ConnectorDrawer({
  open,
  def,
  status,
  onClose,
  onConnect,
  onChanged,
  supportHref,
}: {
  open: boolean;
  /** Kept after close so the sheet does not empty mid-transition. */
  def: ConnectorDef | null;
  status: ConnectorStatus | null;
  onClose: () => void;
  onConnect: (def: ConnectorDef) => void;
  /** A connect, test or disconnect finished: re-read every status from the server. */
  onChanged: () => void;
  /** OASIS's support form, for "tell OASIS you use this". */
  supportHref: string | null;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    returnFocus.current = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      // aria-modal: Tab stays inside the sheet (focus-trap.ts).
      const panel = panelRef.current;
      if (e.key !== "Tab" || !panel) return;
      const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const move = trapTab(
        Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)),
        active,
        e.shiftKey,
        !!active && panel.contains(active),
      );
      if (move.prevent) e.preventDefault();
      move.focus?.focus();
    };
    window.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      returnFocus.current?.focus?.();
    };
  }, [open, onClose]);

  const live = def?.live ?? null;
  const verb = live ? { reads: "What OASIS reads", does: "What OASIS does" } : { reads: "What OASIS will read", does: "What OASIS will do" };
  // A pasted-key app is connected, tested and disconnected right here.
  const keyForm = live?.connect.kind === "key_form" ? live.connect : null;
  const keyConfig = keyForm ? providerById(keyForm.provider)?.restrictedKey ?? null : null;

  return (
    <div
      className={`fixed inset-0 z-50 ${open ? "" : "pointer-events-none"}`}
      // inert, not just aria-hidden: the sheet keeps its content while it
      // slides out, and a closed sheet must not be reachable by Tab.
      inert={!open}
    >
      <div
        onClick={onClose}
        className={`absolute inset-0 bg-black/60 transition-opacity duration-150 motion-reduce:transition-none ${
          open ? "opacity-100" : "opacity-0"
        }`}
      />
      <aside
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="connector-drawer-title"
        className={`absolute right-0 top-0 flex h-full w-full max-w-[26rem] flex-col border-l border-hairline bg-bg-panel
          shadow-[0_12px_32px_rgb(0_0_0/0.55)] transition-[transform,opacity] duration-150 ease-out motion-reduce:transition-none
          pt-[env(safe-area-inset-top,0px)] pb-[env(safe-area-inset-bottom,0px)]
          ${open ? "translate-x-0 opacity-100" : "translate-x-4 opacity-0"}`}
      >
        {def && (
          <>
            <header className="flex items-start gap-3 border-b border-hairline px-5 py-4">
              <ConnectorIcon def={def} size="lg" />
              <div className="min-w-0 flex-1">
                <h2 id="connector-drawer-title" className="text-base font-semibold text-fg">
                  {def.name}
                </h2>
                <p className="mt-0.5 text-[13px] leading-5 text-fg-muted">{def.summary}</p>
              </div>
              <button
                ref={closeRef}
                type="button"
                onClick={onClose}
                className="rounded-md p-1.5 text-fg-dim transition-colors hover:bg-bg-hover hover:text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent/70"
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </button>
            </header>

            <div className="flex-1 space-y-6 overflow-y-auto px-5 py-5 text-sm">
              {status && (
                <section>
                  <h3 className="mb-1.5 text-xs font-medium text-fg-dim">Status</h3>
                  <StatusLine status={status} />
                  {status.detail && (
                    <p className="mt-1.5 text-[13px] leading-5 text-fg-muted">{status.detail}</p>
                  )}
                  {!live && def.plannedFor && (
                    <p className="mt-1.5 text-[13px] leading-5 text-fg-muted">
                      {def.plannedFor === "Phase 2"
                        ? "Scheduled for the next release of OASIS OS. It cannot be connected yet."
                        : "Planned for a later release. It cannot be connected yet."}
                    </p>
                  )}
                </section>
              )}

              {keyForm && keyConfig && (
                // Keyed by app so switching apps never carries a typed key across.
                <KeyConnectionPanel
                  key={def.slug}
                  providerId={keyForm.provider}
                  providerName={def.name}
                  config={keyConfig}
                  status={status}
                  onChanged={onChanged}
                />
              )}

              {def.includes && def.includes.length > 0 && (
                <section>
                  <h3 className="mb-2 text-xs font-medium text-fg-dim">Includes</h3>
                  <ul className="flex flex-wrap gap-2">
                    {def.includes.map((p) => (
                      <li
                        key={p.name}
                        className="inline-flex items-center gap-1.5 rounded-md border border-hairline bg-bg-raised px-2 py-1 text-[12px] text-fg-muted"
                      >
                        <SubProductIcon file={p.file} color={glyphColor({ brandColor: p.color })} />
                        {p.name}
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              <section>
                <h3 className="mb-2 text-xs font-medium text-fg-dim">{verb.reads}</h3>
                <ul className="space-y-1.5 text-[13px] leading-5 text-fg">
                  {def.reads.map((r) => (
                    <li key={r} className="flex gap-2">
                      <span aria-hidden className="mt-[9px] h-1 w-1 shrink-0 rounded-full bg-fg-dim" />
                      {r}
                    </li>
                  ))}
                </ul>
              </section>

              <section>
                <h3 className="mb-2 text-xs font-medium text-fg-dim">{verb.does}</h3>
                <ul className="space-y-1.5 text-[13px] leading-5 text-fg">
                  {def.does.map((d) => (
                    <li key={d} className="flex gap-2">
                      <span aria-hidden className="mt-[9px] h-1 w-1 shrink-0 rounded-full bg-fg-dim" />
                      {d}
                    </li>
                  ))}
                </ul>
              </section>

              <section>
                <h3 className="mb-2 text-xs font-medium text-fg-dim">Used by</h3>
                <ul className="flex flex-wrap gap-1.5">
                  {def.departments.map((d) => (
                    <li
                      key={d}
                      className="rounded-md border border-hairline bg-bg-raised px-2 py-0.5 text-[12px] text-fg-muted"
                    >
                      {departmentLabel(d)}
                    </li>
                  ))}
                </ul>
              </section>

              <p className="text-[11.5px] leading-4 text-fg-dim">
                {def.icon.kind === "svg"
                  ? `The ${def.name} logo is a trademark of its owner, shown to identify the app. OASIS is not endorsed by ${def.name}.`
                  : `No logo is shown for ${def.name}. ${def.icon.reason}.`}
              </p>
            </div>

            {/* A pasted-key app's actions live in its panel above, not here. */}
            {!keyForm && (
              <footer className="border-t border-hairline px-5 py-4">
                {live ? (
                  <button type="button" onClick={() => onConnect(def)} className="btn-primary w-full">
                    {status?.kind === "connected" || status?.kind === "configured" || status?.kind === "attention"
                      ? `Manage ${def.name}`
                      : live.connect.label}
                  </button>
                ) : supportHref ? (
                  <p className="text-[13px] leading-5 text-fg-muted">
                    Use {def.name} today?{" "}
                    <a
                      href={supportHref}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-accent underline-offset-2 hover:underline"
                    >
                      Tell OASIS
                    </a>
                    .
                  </p>
                ) : null}
              </footer>
            )}
          </>
        )}
      </aside>
    </div>
  );
}
