"use client";

/**
 * ConnectionsHub — Settings › Connections: one card per app, and the card is
 * the one place that app is set up (CC, 2026-09-29: the page used to list the
 * same apps again under "Keys and accounts").
 *
 * "Your tools" first: live connectors this workspace has already set up in some
 * way (connected, saved, failing, or not checkable right now). Then every other
 * app, each a card in its own category (Accounting, Banking, Meetings,
 * Messaging & chat, Ads & social ...), with the Custom key card last. An app
 * whose own OASIS app is not set up on this deployment still has its card: it
 * says "Not available on this workspace yet" and opens a drawer that says why,
 * never a button that fails. Apps with nothing built are one compact "Not
 * built yet" row; each opens its drawer, which says why and files a request on
 * OASIS's desk. Statuses arrive computed from the server
 * (lib/os/connectors.ts resolveConnectorStatus), so this component only
 * arranges them — it has no way to make a card look more connected than the
 * server said.
 *
 * Clicking a card opens its drawer, where a key app is connected, tested and
 * removed; an app signed in at the vendor's own page (Constant Contact,
 * QuickBooks, Xero, Zoom, WhatsApp) goes straight to its popup.
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
  OAUTH_POPUP_SOURCE,
  connectorBySlug,
  connectorMatches,
  oauthStartHref,
  type ConnectorDef,
  type ConnectorStatus,
  type ConnectorStatusKind,
} from "@/lib/os/connectors";

/** A live connector counts as "yours" once it reports anything but a clean "not connected". */
function isYourTool(def: ConnectorDef, status: ConnectorStatus | undefined): boolean {
  return !!def.live && !!status && status.kind !== "not_connected" && status.kind !== "coming_soon";
}

const NOT_AVAILABLE = "OASIS's own app for this isn't available on this workspace yet, so it can't connect here. Nothing is wrong on your side.";

/** The sentence for each reason a sign-in popup can end with (lib/connections/oauth-connect.ts, the authorize and callback routes). */
const POPUP_ERRORS: Record<string, string> = {
  admin_only: "Only an owner or admin can connect this.",
  // OASIS's own app for the vendor is not set up on this deployment (its Worker
  // secrets are missing), or is private to OASIS's login.
  not_configured: NOT_AVAILABLE,
  app_credentials_missing: NOT_AVAILABLE,
  state_secret_missing: NOT_AVAILABLE,
  provider_not_available: NOT_AVAILABLE,
  login_required: "Your session expired. Sign in again, then retry.",
  signed_out_or_not_allowed: "Your session expired, or only an owner or admin can connect this. Sign in again, then retry.",
  state_invalid: "That sign-in took too long or was already used. Start again.",
  wrong_person: "That sign-in was started by someone else. Start again from your own screen.",
  exchange_failed: "The app did not accept the sign-in. Try again in a minute.",
  account_unidentified: "The app did not say which account was approved. Try again and approve an account when it asks.",
  several_accounts: "That sign-in covered more than one account. Start again and approve only one.",
  account_connected_elsewhere: "That account is already connected to another OASIS workspace. Disconnect it there first.",
  another_account_connected: "A different account is already connected here. Disconnect it first, then connect the other one.",
  token_save_failed: "OASIS could not save the sign-in, so nothing was connected. Try again.",
  oasis_unavailable: "OASIS could not check your access just now. Try again in a minute.",
};

/**
 * The banner for a sign-in's result: the popup's own postMessage (runPopup's
 * onDone), or a full-window sign-in that had to fall back when the popup was
 * blocked, which comes back on the URL instead (page.tsx's
 * ?connection=&status=&reason=, CodeRabbit PR #574). Both read the same codes,
 * so the result reads the same words either way.
 */
function resultBanner(appName: string, status: string | undefined | null, reason: string | undefined | null): NoticeValue {
  if (!status) return null;
  if (status === "connected") return { tone: "ok", text: `${appName} connected.` };
  if (status === "denied") return { tone: "err", text: "Connection cancelled." };
  return {
    tone: "err",
    text: POPUP_ERRORS[reason || ""] ?? `${appName} did not finish connecting. Try again in a minute.`,
  };
}

/** What opened a sheet on arrival: ?app=, and Google's sign-in result (page.tsx). */
export const DEEP_LINK_PARAMS = ["app", "gmail_oauth", "reason", "gmail", "mailbox", "connection", "status"] as const;

/** A closed sheet stays closed: a refresh must not reopen it or replay a sign-in banner. */
function clearDeepLink() {
  const url = new URL(window.location.href);
  let changed = false;
  for (const key of DEEP_LINK_PARAMS) {
    if (url.searchParams.has(key)) {
      url.searchParams.delete(key);
      changed = true;
    }
  }
  if (changed) window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
}

const CUSTOM_KEYS = {
  title: "Custom keys",
  summary: "Any other app your agents use",
  words: ["custom", "key", "keys", "secret", "token", "webhook", "api", "env", "other"],
};

/**
 * What clicking a card does. Keys (and an app that is not built) open the
 * drawer, where the app is set up or requested; only an OAuth popup or a page
 * link leaves it. Inside the workspace setup (`embedded`) a Settings page is
 * not reachable yet, so a page link opens the drawer, which says where.
 */
export function connectorClickAction(def: ConnectorDef, embedded: boolean): "drawer" | "popup" | "navigate" {
  const action = def.live?.connect;
  if (!action || action.kind === "key_form" || action.kind === "keys") return "drawer";
  if (action.kind === "link") return embedded ? "drawer" : "navigate";
  return "popup";
}

/**
 * A sign-in card already connected, configured or needing attention says
 * "Manage": its primary click should open the details drawer, exactly like
 * its own Details button, rather than start a fresh sign-in (CodeRabbit PR
 * #574, ConnectionsHub.tsx card click). `fromDrawer` is the one exception:
 * the drawer's own footer button (Reconnect/Manage) passes it, because from
 * inside the drawer one of those statuses is exactly when the popup IS wanted.
 */
export function oauthManageOpensDrawer(statusKind: ConnectorStatusKind | undefined, fromDrawer: boolean): boolean {
  // "unknown" (the connections read itself failed) still gets "Manage" as its
  // accessible name (ConnectorCard's primaryLabel only special-cases
  // coming_soon and not_connected), so its click must agree and open the
  // drawer too, never restart a sign-in the card never offered (Codex review, PR #574).
  return !fromDrawer && (statusKind === "connected" || statusKind === "configured" || statusKind === "attention" || statusKind === "unknown");
}

/** The drawer a `?app=` deep link opens on the first render (not after it), or null. */
function deepLinkedApp(initialApp: string | null): string | null {
  return initialApp && initialApp !== "custom-keys" && connectorBySlug(initialApp) ? initialApp : null;
}

export function ConnectionsHub({
  statuses,
  supportHref,
  initialApp,
  personalGoogle,
  embedded = false,
  initialStatus = null,
  initialReason = null,
}: {
  statuses: Record<string, ConnectorStatus>;
  supportHref: string | null;
  /** `?app=<slug>`: that app's drawer opens on arrival. */
  initialApp: string | null;
  /** This workspace connects each person's own Google (not a shared inbox). */
  personalGoogle: boolean;
  /**
   * The workspace setup's connections step (onboarding): the same cards and
   * drawer, but nothing navigates away from the setup. An app set up on
   * another Settings page opens its drawer, which says where.
   */
  embedded?: boolean;
  /**
   * A sign-in's result when the popup was blocked and fell back to a
   * full-window navigation: it comes back on the URL (page.tsx's
   * ?connection=&status=&reason=) instead of the popup's postMessage, so the
   * hub reads the same words from its own first render (CodeRabbit PR #574).
   */
  initialStatus?: string | null;
  initialReason?: string | null;
}) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  // A full-window sign-in that FAILED (the popup was blocked) must show WHY:
  // the banner below (role=status, the same words the popup would have
  // shown) is the thing to see. An auto-opened drawer has nothing in it to
  // explain a refusal — nothing was connected — and on a phone it fully
  // covers the banner, on desktop it sits dimmed behind the dialog (Codex
  // review, PR #574). A successful sign-in still opens its drawer, as before.
  const deepLinkOpensDrawer = initialStatus !== "error";
  // A deep link opens its drawer in the first render, so the page arrives with
  // it open rather than opening a moment later.
  const [drawerSlug, setDrawerSlug] = useState<string | null>(() => (deepLinkOpensDrawer ? deepLinkedApp(initialApp) : null));
  const [drawerOpen, setDrawerOpen] = useState(() => deepLinkOpensDrawer && deepLinkedApp(initialApp) !== null);
  const [customOpen, setCustomOpen] = useState(() => deepLinkOpensDrawer && initialApp === "custom-keys");
  // A full-window sign-in's result (the popup was blocked) is already on the
  // URL at first render, so its banner is read then — not in an effect after —
  // and shows before anything clears those params (CodeRabbit PR #574).
  const [banner, setBanner] = useState<NoticeValue>(() =>
    resultBanner(connectorBySlug(initialApp ?? "")?.name ?? "That app", initialStatus, initialReason),
  );
  // role="status" announces a CHANGE, not content already on the page at
  // mount: a screen reader reading the page right after the full-window
  // navigation can miss text that was there from the first paint (Codex
  // review, PR #574). Clearing it and setting it back once, right after
  // mount, gives assistive tech a real mutation to announce, while the
  // first render (and the static markup this is tested against) still
  // shows the words immediately for a sighted reader.
  useEffect(() => {
    if (!initialStatus) return;
    setBanner(null);
    const id = window.requestAnimationFrame(() =>
      setBanner(resultBanner(connectorBySlug(initialApp ?? "")?.name ?? "That app", initialStatus, initialReason)),
    );
    return () => window.cancelAnimationFrame(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [busySlug, setBusySlug] = useState<string | null>(null);

  const openDrawer = useCallback((slug: string) => {
    setDrawerSlug(slug);
    setDrawerOpen(true);
  }, []);
  const closeDrawer = useCallback(() => {
    setDrawerOpen(false);
    clearDeepLink();
  }, []);
  const closeCustom = useCallback(() => {
    setCustomOpen(false);
    clearDeepLink();
  }, []);

  useEffect(() => {
    if (!deepLinkOpensDrawer) return;
    if (initialApp === "custom-keys") setCustomOpen(true);
    else if (initialApp && connectorBySlug(initialApp)) openDrawer(initialApp);
  }, [initialApp, openDrawer, deepLinkOpensDrawer]);

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
          if (status && status !== "connected" && status !== "denied" && !POPUP_ERRORS[reason || ""]) {
            console.error("[connections.popup]", def.slug, reason);
          }
          setBanner(resultBanner(def.name, status, reason));
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
    (def: ConnectorDef, opts?: { fromDrawer?: boolean }) => {
      const action = def.live?.connect;
      const next = connectorClickAction(def, embedded);
      // A card this workspace cannot connect yet (OASIS's app still waiting on
      // the vendor) opens its drawer, which says why: never a popup that fails.
      if (next === "drawer" || !action || statuses[def.slug]?.kind === "coming_soon") return openDrawer(def.slug);
      // Connected, configured or needing attention says "Manage": the card
      // opens the drawer instead of starting sign-in again. Only the drawer's
      // own footer button bypasses this (fromDrawer) — that IS its Reconnect.
      if (next === "popup" && oauthManageOpensDrawer(statuses[def.slug]?.kind, !!opts?.fromDrawer)) return openDrawer(def.slug);
      setDrawerOpen(false);
      if (next === "popup" && action.kind === "popup") return runPopup(def, action.href, action.messageSource);
      if (next === "popup" && action.kind === "oauth") return runPopup(def, oauthStartHref(action.provider), OAUTH_POPUP_SOURCE);
      if (action.kind === "link") router.push(action.href);
    },
    [openDrawer, router, runPopup, embedded, statuses],
  );

  const visible = useMemo(
    () => CONNECTOR_CATALOG.filter((def) => connectorMatches(def, query)),
    [query],
  );
  const yours = visible.filter((def) => isYourTool(def, statuses[def.slug]));
  // Every app with a way to connect has its own card in its own category, whether
  // or not OASIS's app for it is switched on here: an unavailable one says so on
  // the card ("Not available on this workspace yet") and opens its drawer, never
  // a button that fails. Only an app with nothing built sits apart below.
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
              Apps
            </h2>
            <p className="mt-0.5 text-[13px] leading-5 text-fg-muted">
              Open an app to connect it: a sign-in on the app&apos;s own page, or a key you paste. Keys are stored
              encrypted and never shown again.
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
            Not built yet
          </h2>
          <p className="mt-0.5 text-[13px] leading-5 text-fg-muted">
            Not connectable today. Open one to see why, and ask OASIS for it in one click.
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
        onConnect={(d) => connect(d, { fromDrawer: true })}
        onChanged={() => router.refresh()}
        personalGoogle={personalGoogle}
        embedded={embedded}
        requestFrom={embedded ? "the workspace setup" : "Settings > Connections"}
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
  // A card OASIS cannot connect here yet (its app is not set up) offers the
  // drawer that says why, never its connect button.
  const unavailable = live && shown.kind === "coming_soon";
  const primaryLabel = unavailable || !live
    ? `About ${def.name}`
    : shown.kind === "not_connected"
      ? def.live!.connect.label
      : `Manage ${def.name}`;
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
