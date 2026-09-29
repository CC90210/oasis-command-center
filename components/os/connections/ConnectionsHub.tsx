"use client";

/**
 * ConnectionsHub — the app grid at the top of Settings › Connections.
 *
 * "Your tools" first: live connectors this workspace has already set up in some
 * way (connected, saved, failing, or not checkable right now). Then the full
 * catalog, grouped by purpose and searchable. Statuses arrive computed from the
 * server (lib/os/connectors.ts resolveConnectorStatus), so this component only
 * arranges them — it has no way to make a card look more connected than the
 * server said.
 *
 * Clicking a live card opens the flow that already exists for it: the shared
 * key editor and your own Google connection further down this page, the
 * Telegram setup on Chat apps, or Constant Contact's OAuth popup. Clicking a
 * coming-soon card opens the detail drawer. Every card also has a Details
 * button, so the drawer is one click away for live apps too.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Info, Search } from "lucide-react";
import { ConnectorIcon } from "@/components/os/connections/ConnectorIcon";
import { ConnectorDrawer } from "@/components/os/connections/ConnectorDrawer";
import { watchPopup } from "@/components/os/connections/popup-watch";
import { StatusLine } from "@/components/os/connections/StatusLine";
import {
  CONNECTOR_CATALOG,
  CONNECTOR_CATEGORIES,
  connectorBySlug,
  connectorMatches,
  type ConnectorDef,
  type ConnectorStatus,
} from "@/lib/os/connectors";

/** A live connector counts as "yours" once it reports anything but a clean "not connected". */
function isYourTool(def: ConnectorDef, status: ConnectorStatus | undefined): boolean {
  return !!def.live && !!status && status.kind !== "not_connected" && status.kind !== "coming_soon";
}

const POPUP_ERRORS: Record<string, string> = {
  admin_only: "Only an owner or admin can connect this.",
  not_configured: "This app is not enabled for your workspace yet. Ask OASIS to turn it on.",
  login_required: "Your session expired. Sign in again, then retry.",
};

/**
 * Open a section on THIS page by id. A plain same-page anchor does not fire
 * `hashchange` when the hash is already the one in the URL, so a section the
 * user closed would stay closed; this opens it directly.
 */
function openOnThisPage(href: string): boolean {
  const url = new URL(href, window.location.href);
  if (url.pathname !== window.location.pathname || !url.hash) return false;
  const el = document.getElementById(url.hash.slice(1));
  if (!el) return false;
  if (el instanceof HTMLDetailsElement) el.open = true;
  window.history.replaceState(null, "", url.hash);
  requestAnimationFrame(() => el.scrollIntoView({ block: "start", behavior: "smooth" }));
  return true;
}

export function ConnectionsHub({
  statuses,
  supportHref,
}: {
  statuses: Record<string, ConnectorStatus>;
  supportHref: string | null;
}) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [drawerSlug, setDrawerSlug] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [banner, setBanner] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [busySlug, setBusySlug] = useState<string | null>(null);

  const openDrawer = useCallback((slug: string) => {
    setDrawerSlug(slug);
    setDrawerOpen(true);
  }, []);
  const closeDrawer = useCallback(() => setDrawerOpen(false), []);

  // The one popup being watched. Stopped on unmount and before another popup
  // starts, so its listener and poll never outlive this hub (popup-watch.ts).
  const stopWatch = useRef<(() => void) | null>(null);
  useEffect(
    () => () => {
      stopWatch.current?.();
      stopWatch.current = null;
    },
    [],
  );

  const runPopup = useCallback(
    (def: ConnectorDef, href: string, source: string) => {
      stopWatch.current?.();
      stopWatch.current = null;
      setBanner(null);
      setBusySlug(def.slug);
      const popup = window.open(href, `${source}_connect`, "popup,width=620,height=780");
      if (!popup) {
        // Popup blocked: the start route is a plain redirect, so a full-window
        // navigation works too (it returns to the app when it finishes).
        window.location.href = href;
        return;
      }
      stopWatch.current = watchPopup({
        popup,
        source,
        env: {
          origin: window.location.origin,
          addMessageListener: (fn) => window.addEventListener("message", fn),
          removeMessageListener: (fn) => window.removeEventListener("message", fn),
          setInterval: (fn, ms) => window.setInterval(fn, ms),
          clearInterval: (handle) => window.clearInterval(handle as number),
        },
        onDone: ({ status, reason }) => {
          stopWatch.current = null;
          setBusySlug(null);
          if (status === "connected") {
            setBanner({ tone: "ok", text: `${def.name} connected.` });
          } else if (status === "denied") {
            setBanner({ tone: "err", text: "Connection cancelled." });
          } else if (status) {
            setBanner({
              tone: "err",
              text: POPUP_ERRORS[reason || ""] ?? `${def.name} could not connect (${reason || "unknown error"}).`,
            });
          }
          // Re-read every status from the server either way: a popup closed with
          // no message may still have finished.
          router.refresh();
          try {
            popup.close();
          } catch {
            /* already closed */
          }
        },
      });
    },
    [router],
  );

  const connect = useCallback(
    (def: ConnectorDef) => {
      const action = def.live?.connect;
      if (!action) return openDrawer(def.slug);
      setDrawerOpen(false);
      if (action.kind === "popup") return runPopup(def, action.href, action.messageSource);
      if (!openOnThisPage(action.href)) router.push(action.href);
    },
    [openDrawer, router, runPopup],
  );

  const visible = useMemo(
    () => CONNECTOR_CATALOG.filter((def) => connectorMatches(def, query)),
    [query],
  );
  const yours = visible.filter((def) => isYourTool(def, statuses[def.slug]));
  const rest = visible.filter((def) => !isYourTool(def, statuses[def.slug]));

  const drawerDef = drawerSlug ? connectorBySlug(drawerSlug) : null;

  return (
    <div className="space-y-8">
      <div className="relative max-w-md">
        <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-dim" />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search apps"
          aria-label="Search apps"
          className="input !pl-9"
        />
      </div>

      {banner && (
        <div
          role="status"
          className={`rounded-lg border px-3 py-2 text-[13px] ${
            banner.tone === "ok"
              ? "border-status-engaged/30 bg-status-engaged/10 text-fg"
              : "border-status-hot/30 bg-status-hot/10 text-fg"
          }`}
        >
          {banner.text}
        </div>
      )}

      <section aria-labelledby="your-tools-heading">
        <h2 id="your-tools-heading" className="text-sm font-semibold text-fg">
          Your tools
        </h2>
        <p className="mt-0.5 text-[13px] leading-5 text-fg-muted">
          Apps already set up for this workspace, with the status OASIS last measured.
        </p>
        {yours.length > 0 ? (
          <ul className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {yours.map((def) => (
              <ConnectorCard
                key={def.slug}
                def={def}
                status={statuses[def.slug]}
                busy={busySlug === def.slug}
                onConnect={connect}
                onDetails={openDrawer}
              />
            ))}
          </ul>
        ) : (
          <p className="mt-3 rounded-xl border border-dashed border-hairline px-4 py-5 text-[13px] text-fg-muted">
            {query
              ? "None of your connected apps match this search."
              : "Nothing is connected yet. Apps marked Not connected below can be set up today."}
          </p>
        )}
      </section>

      {CONNECTOR_CATEGORIES.map((cat) => {
        const items = rest.filter((d) => d.category === cat.key);
        if (items.length === 0) return null;
        // Connectable apps first, then the ones still being built.
        items.sort((a, b) => Number(!a.live) - Number(!b.live));
        return (
          <section key={cat.key} aria-labelledby={`cat-${cat.key}`}>
            <h2 id={`cat-${cat.key}`} className="text-sm font-semibold text-fg">
              {cat.label}
            </h2>
            <ul className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
              {items.map((def) => (
                <ConnectorCard
                  key={def.slug}
                  def={def}
                  status={statuses[def.slug]}
                  busy={busySlug === def.slug}
                  onConnect={connect}
                  onDetails={openDrawer}
                />
              ))}
            </ul>
          </section>
        );
      })}

      {visible.length === 0 && (
        <p className="text-[13px] text-fg-muted">
          No apps match &ldquo;{query}&rdquo;.{" "}
          {supportHref && (
            <a href={supportHref} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">
              Tell OASIS what you use
            </a>
          )}
        </p>
      )}

      <ConnectorDrawer
        open={drawerOpen && !!drawerDef}
        def={drawerDef}
        status={drawerDef ? statuses[drawerDef.slug] ?? null : null}
        onClose={closeDrawer}
        onConnect={connect}
        supportHref={supportHref}
      />
    </div>
  );
}

function ConnectorCard({
  def,
  status,
  busy,
  onConnect,
  onDetails,
}: {
  def: ConnectorDef;
  status: ConnectorStatus | undefined;
  busy: boolean;
  onConnect: (def: ConnectorDef) => void;
  onDetails: (slug: string) => void;
}) {
  const live = !!def.live;
  // No status from the server is unknown, never "not connected".
  const shown: ConnectorStatus = status ?? { kind: "unknown", label: "Status unavailable" };
  const primaryLabel = live
    ? shown.kind === "not_connected"
      ? def.live!.connect.label
      : `Manage ${def.name}`
    : `About ${def.name}`;
  return (
    <li className="group relative flex items-center gap-3 rounded-xl border border-hairline bg-bg-panel px-3 py-3 transition-colors duration-150 hover:border-bg-border-strong hover:bg-bg-hover">
      {/* The whole card is the primary action; Details sits above it. */}
      <button
        type="button"
        onClick={() => (live ? onConnect(def) : onDetails(def.slug))}
        disabled={busy}
        aria-label={primaryLabel}
        className="absolute inset-0 rounded-xl focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent/70 disabled:cursor-wait"
      />
      <ConnectorIcon def={def} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-fg">{def.name}</div>
        <div className="truncate text-[12px] leading-4 text-fg-dim">{def.summary}</div>
        <StatusLine status={busy ? { kind: "configured", label: "Waiting for the provider…" } : shown} className="mt-1" />
      </div>
      <button
        type="button"
        onClick={() => onDetails(def.slug)}
        className="relative z-10 rounded-md p-1.5 text-fg-dim transition-colors hover:bg-bg-elev hover:text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent/70"
        aria-label={`Details about ${def.name}`}
        title="Details"
      >
        <Info className="h-4 w-4" />
      </button>
    </li>
  );
}
