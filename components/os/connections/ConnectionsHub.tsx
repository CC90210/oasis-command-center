"use client";

/**
 * ConnectionsHub — Settings › Connections: one card per app, and the card is
 * the one place that app is set up (CC, 2026-09-29: the page used to list the
 * same apps again under "Keys and accounts").
 *
 * "Your tools" first: live connectors this workspace has already set up in some
 * way (connected, saved, failing, or not checkable right now). Then the apps
 * that can be connected today, grouped by purpose, with the Custom key card
 * last. Apps that are not built yet are one compact "Coming later" row, not a
 * grid of cards that do nothing. Statuses arrive computed from the server
 * (lib/os/connectors.ts resolveConnectorStatus), so this component only
 * arranges them — it has no way to make a card look more connected than the
 * server said.
 *
 * Clicking a card opens its drawer, where the app is connected, tested and
 * removed; only an OAuth app (Constant Contact) goes straight to its popup.
 * `?app=<slug>` opens that app's drawer (lib/os/connectors.ts connectorHref),
 * and Google's sign-in comes back to it.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Info, KeyRound, Search } from "lucide-react";
import { ConnectorIcon } from "@/components/os/connections/ConnectorIcon";
import { ConnectorDrawer, DrawerSheet } from "@/components/os/connections/ConnectorDrawer";
import { CustomCredentialsVault } from "@/components/settings/CustomCredentialsVault";
import { watchPopup } from "@/components/os/connections/popup-watch";
import { StatusLine } from "@/components/os/connections/StatusLine";
import { Notice, type NoticeValue } from "@/components/os/connections/Notice";
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

const CUSTOM_KEYS = {
  title: "Custom keys",
  summary: "Any other app your agents use",
  words: ["custom", "key", "keys", "secret", "token", "webhook", "api", "env", "other"],
};

export function ConnectionsHub({
  statuses,
  supportHref,
  initialApp,
  personalGoogle,
}: {
  statuses: Record<string, ConnectorStatus>;
  supportHref: string | null;
  /** `?app=<slug>`: that app's drawer opens on arrival. */
  initialApp: string | null;
  /** This workspace connects each person's own Google (not a shared inbox). */
  personalGoogle: boolean;
}) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [drawerSlug, setDrawerSlug] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [customOpen, setCustomOpen] = useState(false);
  const [banner, setBanner] = useState<NoticeValue>(null);
  const [busySlug, setBusySlug] = useState<string | null>(null);

  const openDrawer = useCallback((slug: string) => {
    setDrawerSlug(slug);
    setDrawerOpen(true);
  }, []);
  const closeDrawer = useCallback(() => {
    setDrawerOpen(false);
    // The drawer that ?app= opened is closed: a refresh must not reopen it.
    const url = new URL(window.location.href);
    if (url.searchParams.has("app")) {
      url.searchParams.delete("app");
      window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
    }
  }, []);
  const closeCustom = useCallback(() => setCustomOpen(false), []);

  useEffect(() => {
    if (initialApp === "custom-keys") setCustomOpen(true);
    else if (initialApp && connectorBySlug(initialApp)) openDrawer(initialApp);
  }, [initialApp, openDrawer]);

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
      // Keys are set up in the drawer itself (form, Test, Remove), so the card
      // opens the drawer; only an OAuth popup or a page link leaves it.
      if (!action || action.kind === "key_form" || action.kind === "keys") return openDrawer(def.slug);
      setDrawerOpen(false);
      if (action.kind === "popup") return runPopup(def, action.href, action.messageSource);
      router.push(action.href);
    },
    [openDrawer, router, runPopup],
  );

  const visible = useMemo(
    () => CONNECTOR_CATALOG.filter((def) => connectorMatches(def, query)),
    [query],
  );
  const yours = visible.filter((def) => isYourTool(def, statuses[def.slug]));
  const available = visible.filter((def) => def.live && !isYourTool(def, statuses[def.slug]));
  const later = visible.filter((def) => !def.live);
  const q = query.trim().toLowerCase();
  const customVisible = !q || CUSTOM_KEYS.words.some((w) => w.includes(q) || q.includes(w));

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

      <Notice notice={banner} />

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

      {(available.length > 0 || customVisible) && (
        <section aria-labelledby="set-up-heading" className="space-y-5">
          <div>
            <h2 id="set-up-heading" className="text-sm font-semibold text-fg">
              Connect today
            </h2>
            <p className="mt-0.5 text-[13px] leading-5 text-fg-muted">
              Open an app to connect it. Keys are stored encrypted and never shown again.
            </p>
          </div>
          {CONNECTOR_CATEGORIES.map((cat) => {
            const items = available.filter((d) => d.category === cat.key);
            if (items.length === 0) return null;
            return (
              <div key={cat.key}>
                <h3 id={`cat-${cat.key}`} className="text-xs font-medium text-fg-dim">
                  {cat.label}
                </h3>
                <ul aria-labelledby={`cat-${cat.key}`} className="mt-2 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
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
              </div>
            );
          })}
          {customVisible && (
            <div>
              <h3 id="cat-other" className="text-xs font-medium text-fg-dim">
                Anything else
              </h3>
              <ul aria-labelledby="cat-other" className="mt-2 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                <li className="group relative flex items-center gap-3 rounded-xl border border-hairline bg-bg-panel px-3 py-3 transition-colors duration-150 hover:border-bg-border-strong hover:bg-bg-hover">
                  <button
                    type="button"
                    onClick={() => setCustomOpen(true)}
                    aria-label="Open Custom keys"
                    className="absolute inset-0 rounded-xl focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent/70"
                  />
                  <CustomKeysIcon />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-fg">{CUSTOM_KEYS.title}</div>
                    <div className="truncate text-[12px] leading-4 text-fg-dim">{CUSTOM_KEYS.summary}</div>
                  </div>
                </li>
              </ul>
            </div>
          )}
        </section>
      )}

      {later.length > 0 && (
        <section aria-labelledby="later-heading">
          <h2 id="later-heading" className="text-sm font-semibold text-fg">
            Coming later
          </h2>
          <p className="mt-0.5 text-[13px] leading-5 text-fg-muted">
            Not connectable yet. Open one to see what it will do.
          </p>
          <ul className="mt-3 flex flex-wrap gap-1.5">
            {later.map((def) => (
              <li key={def.slug}>
                <button
                  type="button"
                  onClick={() => openDrawer(def.slug)}
                  className="inline-flex items-center gap-2 rounded-lg border border-hairline bg-bg-panel py-1 pl-1 pr-2.5 text-[13px] text-fg-muted transition-colors duration-150 hover:border-bg-border-strong hover:text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent/70"
                >
                  <ConnectorIcon def={def} size="sm" />
                  {def.name}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {visible.length === 0 && !customVisible && (
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
        onChanged={() => router.refresh()}
        supportHref={supportHref}
        personalGoogle={personalGoogle}
      />

      <DrawerSheet
        open={customOpen}
        onClose={closeCustom}
        head={{ icon: <CustomKeysIcon size="lg" />, title: CUSTOM_KEYS.title, summary: CUSTOM_KEYS.summary }}
      >
        <p className="text-[13px] leading-5 text-fg-muted">
          For an app with no card: a client&apos;s API token, a webhook URL, an internal key. Values are stored encrypted
          and never shown again. An agent can use one by name for a request it makes; the value itself never enters the
          chat.
        </p>
        <CustomCredentialsVault />
      </DrawerSheet>
    </div>
  );
}

function CustomKeysIcon({ size = "md" }: { size?: "md" | "lg" }) {
  return (
    <span
      aria-hidden
      className={`inline-flex shrink-0 items-center justify-center border border-hairline bg-bg-raised text-fg-muted ${
        size === "lg" ? "h-11 w-11 rounded-xl" : "h-9 w-9 rounded-lg"
      }`}
    >
      <KeyRound className={size === "lg" ? "h-5 w-5" : "h-4 w-4"} />
    </span>
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
