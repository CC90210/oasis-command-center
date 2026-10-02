"use client";

/**
 * ConnectorDrawer — the detail sheet for one app in the Connections hub.
 *
 * Says, in plain English, what OASIS reads and does with the app, which
 * departments depend on it, and its status in the same words as the card. A
 * coming-soon app opens here instead of a connect flow. A live app is set up
 * right here, under the status: a Connections-framework key (Stripe) in
 * KeyConnectionPanel, the app's saved keys (Google's sender, Twilio, the
 * Telegram team bot) in ServiceKeysForm, and your own Google login in the
 * personal panel. Only an OAuth app (Constant Contact) keeps its connect
 * button at the bottom, because that flow runs in a popup.
 *
 * DrawerSheet is the sheet itself, shared with the hub's Custom keys card. An
 * overlay, so it is the one place in the hub that carries a shadow (a y-offset,
 * neutral tint). Motion is opacity + transform at 140ms and switches off under
 * prefers-reduced-motion. Esc and the backdrop close it; focus moves to the
 * close button on open, Tab and Shift+Tab stay inside it while it is open, and
 * focus goes back to whatever opened it on close.
 */

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import { ConnectorIcon, SubProductIcon } from "@/components/os/connections/ConnectorIcon";
import { KeyConnectionPanel } from "@/components/os/connections/KeyConnectionPanel";
import { ServiceKeysForm } from "@/components/os/connections/ServiceKeysForm";
import { TwilioWebhooksPanel } from "@/components/os/connections/TwilioWebhooksPanel";
import { StatusLine } from "@/components/os/connections/StatusLine";
import { PersonalIntegrationsPanel } from "@/components/settings/PersonalIntegrationsPanel";
import { FOCUSABLE_SELECTOR, trapTab } from "@/components/os/connections/focus-trap";
import { glyphColor, type ConnectorDef, type ConnectorStatus } from "@/lib/os/connectors";
import { providerById } from "@/lib/connections/registry";
import { OS_DEPARTMENTS } from "@/lib/os/departments";

function departmentLabel(key: string): string {
  return OS_DEPARTMENTS.find((d) => d.key === key)?.label ?? key;
}

export function DrawerSheet({
  open,
  onClose,
  head,
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  /** Kept after close so the sheet does not empty mid-transition; null renders nothing. */
  head: { icon: ReactNode; title: string; summary: string } | null;
  children?: ReactNode;
  footer?: ReactNode;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const titleId = useId();

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
        aria-labelledby={titleId}
        className={`absolute right-0 top-0 flex h-full w-full max-w-[26rem] flex-col border-l border-hairline bg-bg-panel
          shadow-[0_12px_32px_rgb(0_0_0/0.55)] transition-[transform,opacity] duration-150 ease-out motion-reduce:transition-none
          pt-[env(safe-area-inset-top,0px)] pb-[env(safe-area-inset-bottom,0px)]
          ${open ? "translate-x-0 opacity-100" : "translate-x-4 opacity-0"}`}
      >
        {head && (
          <>
            <header className="flex items-start gap-3 border-b border-hairline px-5 py-4">
              {head.icon}
              <div className="min-w-0 flex-1">
                <h2 id={titleId} className="text-base font-semibold text-fg">
                  {head.title}
                </h2>
                <p className="mt-0.5 text-[13px] leading-5 text-fg-muted">{head.summary}</p>
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
            <div className="flex-1 space-y-6 overflow-y-auto px-5 py-5 text-sm">{children}</div>
            {footer}
          </>
        )}
      </aside>
    </div>
  );
}

export function ConnectorDrawer({
  open,
  def,
  status,
  onClose,
  onConnect,
  onChanged,
  supportHref,
  personalGoogle,
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
  /** This workspace connects each person's own Google (not a shared inbox). */
  personalGoogle: boolean;
}) {
  const live = def?.live ?? null;
  const verb = live ? { reads: "What OASIS reads", does: "What OASIS does" } : { reads: "What OASIS will read", does: "What OASIS will do" };
  // A pasted-key app is connected, tested and disconnected right here.
  const keyForm = live?.connect.kind === "key_form" ? live.connect : null;
  const keyConfig = keyForm ? providerById(keyForm.provider)?.restrictedKey ?? null : null;
  const savedKeys = live?.connect.kind === "keys" ? live.connect : null;
  const setUpHere = !!keyForm || !!savedKeys;
  // Bumped by every saved or removed key, so the Twilio panel re-reads the
  // sender it is about to configure. The status label is no such signal: saving
  // an Auth Token on an incomplete setup leaves it "Needs attention", and the
  // panel then confirmed against the old sender while the POST used the new one.
  const [keysRevision, setKeysRevision] = useState(0);
  const onKeysChanged = useCallback(() => {
    setKeysRevision((n) => n + 1);
    onChanged();
  }, [onChanged]);

  // An app set up in the drawer has its actions in the body, not down here.
  const footer =
    def && !setUpHere ? (
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
            <a href={supportHref} target="_blank" rel="noopener noreferrer" className="text-accent underline-offset-2 hover:underline">
              Tell OASIS
            </a>
            .
          </p>
        ) : null}
      </footer>
    ) : null;

  return (
    <DrawerSheet
      open={open}
      onClose={onClose}
      head={def ? { icon: <ConnectorIcon def={def} size="lg" />, title: def.name, summary: def.summary } : null}
      footer={footer}
    >
      {def && (
        <>
          {status && (
            <section>
              <h3 className="mb-1.5 text-xs font-medium text-fg-dim">Status</h3>
              <StatusLine status={status} />
              {status.detail && <p className="mt-1.5 text-[13px] leading-5 text-fg-muted">{status.detail}</p>}
              {!live && def.plannedFor && (
                // The state, not a release promise: "scheduled for the next
                // release" was a date nobody had set.
                <p className="mt-1.5 text-[13px] leading-5 text-fg-muted">
                  Nothing is built for it yet, so it cannot be connected.
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

          {savedKeys && (
            <ServiceKeysForm key={def.slug} service={savedKeys.service} appName={def.name} canManage onChanged={onKeysChanged} />
          )}

          {savedKeys?.service === "twilio" && <TwilioWebhooksPanel key={def.slug} canManage version={keysRevision} />}

          {def.yourAccount === "google" && personalGoogle && (
            <section>
              <h3 className="mb-1.5 text-xs font-medium text-fg-dim">Your own Google account</h3>
              <p className="mb-3 text-[13px] leading-5 text-fg-muted">
                Tied to your login only. It sends as you and puts your booked calls on your calendar; a teammate connects
                their own.
              </p>
              <PersonalIntegrationsPanel showGmail showKixie={false} />
            </section>
          )}

          {def.seeAlso && (
            <p className="text-[13px] leading-5 text-fg-muted">
              <a href={def.seeAlso.href} className="text-accent underline-offset-2 hover:underline">
                {def.seeAlso.label}
              </a>
              .
            </p>
          )}

          {def.docs && (
            <p className="text-[13px] leading-5 text-fg-muted">
              <a href={def.docs.href} target="_blank" rel="noopener noreferrer" className="text-accent underline-offset-2 hover:underline">
                {def.docs.label}
              </a>{" "}
              explains where each value comes from.
            </p>
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
                <li key={d} className="rounded-md border border-hairline bg-bg-raised px-2 py-0.5 text-[12px] text-fg-muted">
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
        </>
      )}
    </DrawerSheet>
  );
}
