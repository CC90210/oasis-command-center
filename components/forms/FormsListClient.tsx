"use client";

/**
 * FormsListClient - the Offers page's two lists (/forms, labelled Offers).
 *
 * Server component above passes initialRows; this client component
 * handles the create flows and per-row toggle/delete.
 *
 *   Offers        forms with an offer page (form_offer_pages), as CARDS (R1,
 *                 2026-10-12, HANDOVER section 3: "they literally look the
 *                 exact same" as the table below). Each card: the one-line
 *                 promise from the page's own hero, the page's status (Live,
 *                 version N / Live + unpublished changes / Draft page), its
 *                 VSL status, new leads in the last 7 days, responses, Edit,
 *                 and ONE link: the landing page's own address. While the page
 *                 is public, Copy link / Open page / Share all hand out that
 *                 page. While it is a draft (or switched off) the card says so
 *                 and offers Open draft + Publish, never a link that would
 *                 show only the bare form (CC, 2026-10-16: "the copy link
 *                 sends us to the intake form... redundancy and overlap").
 *                 The form at slug "vsl" (if any)
 *                 is pinned above the grid as the "Start here" router card;
 *                 with none, a quiet empty-state card offers Create.
 *   Intake forms  forms without a page, exactly as before, in a plain table
 *                 visibly secondary to Offers (the Client Support Ticket is
 *                 one, and stays one).
 *
 * New offer (primary) opens the template picker: a template (structure only),
 * the offer's name (internal) and its link name (the slug, fixed once made).
 * It creates the form with the template's steps, then its draft page, and opens
 * the builder. The page goes public at Publish; until then the link shows the
 * plain form, titled with the workspace's name: an offer's name is internal,
 * and the public route never shows it (app/f/[tenant_slug]/[form_slug]/page.tsx).
 * New intake form is today's starter.
 *
 * canEdit comes from the page (formsEditRefusal, lib/forms/access.ts), the
 * same rule the API enforces. Without it the lists draw no New offer, no New
 * intake form, no on/off switch, no Edit and no Delete: only the forms, their
 * links and their responses. readOnlyNote replaces the default "who may change
 * forms" sentence when the page has a different reason (a retired workspace).
 * A number that could not be read shows "-", never a zero.
 */

import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { Plus, Edit3, ToggleLeft, ToggleRight, Trash2, ExternalLink, Loader2, Copy, Check, Share2, X } from "lucide-react";
import { starterFormForTenant } from "@/lib/forms/tenant-form-config";
import { OFFER_TEMPLATES, starterStepsForTemplate } from "@/lib/offer-pages/templates";
import type { TemplateKey } from "@/lib/offer-pages/types";
import { OffersCardsGrid, type OfferCardEntry } from "./OffersCardsClient";
import type { OfferCardViewModel } from "./OfferCard";
import { offerCreateSlug, slugTakenMessage, ROUTER_SLUG } from "@/lib/offers/router-create";
import { offerShareablePath } from "@/lib/offers/short-links";
import type { FunnelCounts } from "@/lib/offers/tracking-store";

type FormRow = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  enabled: boolean;
  created_at: string;
  updated_at: string;
};

export type OfferColumn = {
  status: "live" | "live_with_changes" | "draft";
  publishedVersion: number;
  /** The hero headline/subheadline/video of the copy a card shows. Optional: a caller built before R1 (tests included) may omit them, and the card falls back to an honest placeholder - never a 0 or an invented promise. */
  headline?: string | null;
  subheadline?: string | null;
  hasVideo?: boolean;
};

/** Today's date in YYYY-MM-DD for default form names. */
function todayStamp(): string {
  return new Date().toISOString().slice(0, 10);
}

/** A link name from an offer name: lowercase, dashes, the API's slug rule. */
function slugify(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return s.length >= 2 ? s : "";
}

const SLUG_RE = /^[a-z0-9][a-z0-9_-]{1,62}$/;

/** Share presets: a source tag on the link, read by Offers once tracking ships. */
const SHARE_PRESETS: Array<{ label: string; params: string }> = [
  { label: "Instagram DM", params: "utm_source=instagram&utm_medium=dm" },
  { label: "Meta ad", params: "utm_source=meta&utm_medium=paid_social" },
  { label: "Google ad", params: "utm_source=google&utm_medium=cpc" },
  { label: "Email", params: "utm_source=email&utm_medium=email" },
  { label: "SMS", params: "utm_source=sms&utm_medium=sms" },
];

export function FormsListClient({
  initialRows,
  tenantLogoUrl,
  tenantSlug,
  tenantName,
  profileSlug,
  canEdit,
  readOnlyNote,
  responseCounts,
  offers = null,
  recentLeads = {},
  recentFunnel = {},
}: {
  initialRows: FormRow[];
  tenantLogoUrl: string | null;
  tenantSlug: string | null;
  /** tenants.name — the neutral starter's headline is the tenant's own name. */
  tenantName: string | null;
  /** Resolved PROFILE slug ("sun" for SunBiz) — picks the starter template. */
  profileSlug: string | null;
  /** May this viewer create, switch off, edit or delete forms? */
  canEdit: boolean;
  /** Why not, when the reason is not the viewer's role (a retired workspace). */
  readOnlyNote?: string;
  /** Responses per form id; null where the count could not be read. */
  responseCounts: Record<string, number | null>;
  /** Forms with an offer page, by id; null when offer pages are not available here yet. */
  offers?: Record<string, OfferColumn> | null;
  /** New leads in the last 7 days per offer form; null where it could not be read. */
  recentLeads?: Record<string, number | null>;
  /** Views/video plays/community-click counts per offer form over the same
   *  7-day window (V5a, offer_funnel_events). Missing = untracked (table not
   *  applied here yet); each metric's own null = a failed read. */
  recentFunnel?: Record<string, FunnelCounts>;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [rows, setRows] = useState(initialRows);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // false = closed; "offer" = the ordinary New offer picker; "router" = the
  // same picker, but Create must land on slug "vsl" (the Start here card's
  // empty state, OffersCardsClient.tsx).
  const [picker, setPicker] = useState<false | "offer" | "router">(false);

  const offerRows = useMemo(() => rows.filter((r) => offers && offers[r.id]), [rows, offers]);
  const intakeRows = useMemo(() => rows.filter((r) => !(offers && offers[r.id])), [rows, offers]);

  // Flash message when the operator just saved and got bounced here from
  // the editor. Auto-clears after a few seconds and strips the query
  // param so a page refresh doesn't re-fire the toast.
  const [savedFlash, setSavedFlash] = useState(false);
  useEffect(() => {
    if (searchParams.get("saved") === "1") {
      setSavedFlash(true);
      const t = setTimeout(() => setSavedFlash(false), 3000);
      // Strip the query without refetching the RSC.
      router.replace("/forms", { scroll: false });
      return () => clearTimeout(t);
    }
  }, [searchParams, router]);

  async function createForm() {
    setCreating(true);
    setError(null);
    try {
      // Mint a unique slug — operator can change it before save (well,
      // can't, since slug is immutable, but the starter slug is OK).
      const slug = `form-${Date.now().toString(36)}`;
      // Tenant-scoped starter — SunBiz gets its doc-collection template,
      // everyone else a neutral contact form in THEIR branding (see
      // lib/forms/tenant-form-config.ts).
      const res = await fetch("/api/forms", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...starterFormForTenant(profileSlug, tenantName, tenantLogoUrl),
          name: `New form - ${todayStamp()}`,
          slug,
        }),
      });
      const data = (await res.json()) as { ok: boolean; form?: { id: string }; error?: string; message?: string };
      if (!data.ok || !data.form) {
        // The server's own sentence when it sends one (a refused editor reads
        // who may change forms), the error code otherwise.
        setError(
          data.error === "slug_taken"
            ? "Slug collision - try New intake form again (we'll mint a new one)."
            : data.message || `Couldn't create form: ${data.error || `http_${res.status}`}`,
        );
        return;
      }
      router.push(`/forms/${data.form.id}/edit`);
    } catch (err) {
      setError(`Couldn't create form: ${err instanceof Error ? err.message : "network_error"}`);
    } finally {
      setCreating(false);
    }
  }

  async function toggle(id: string, enabled: boolean) {
    const next = !enabled;
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, enabled: next } : r)));
    const res = await fetch(`/api/forms/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: next }),
    });
    if (!res.ok) {
      setRows((prev) => prev.map((r) => (r.id === id ? { ...r, enabled } : r)));
      return;
    }
    // Invalidate the cached /forms RSC payload so the next navigation
    // picks up the new toggle state (Next.js 15 router-cache fix).
    router.refresh();
  }

  // Per-row "Copy" feedback. Keyed by form id so the check icon only
  // appears on the row the operator just clicked.
  const [copiedId, setCopiedId] = useState<string | null>(null);
  /** The public path; absoluteUrl() adds the origin, in a click handler only. */
  function publicFormPath(formSlug: string): string | null {
    return tenantSlug ? `/f/${tenantSlug}/${formSlug}` : null;
  }
  async function copyText(key: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(key);
      setTimeout(() => {
        setCopiedId((prev) => (prev === key ? null : prev));
      }, 1800);
    } catch {
      // Clipboard API blocked (rare — old browsers, insecure contexts).
      // Fall back to a window.prompt so the operator can still grab the
      // URL manually.
      window.prompt("Copy this URL:", text);
    }
  }
  async function copyPublicUrl(formId: string, formSlug: string, what: "form" | "page" = "form") {
    const path = what === "page" ? offerShareablePath(tenantSlug, formSlug) : publicFormPath(formSlug);
    if (!path) {
      setError("Couldn't build the link: refresh the page and try again.");
      return;
    }
    await copyText(formId, absoluteUrl(path));
  }

  async function destroy(id: string, name: string) {
    if (!confirm(`Delete "${name}"? Its page and its form go together. This can't be undone.`)) return;
    const res = await fetch(`/api/forms/${id}`, { method: "DELETE" });
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
      setError(data.message || `Couldn't delete form: ${data.error || `delete failed (${res.status})`}`);
      return;
    }
    setRows((prev) => prev.filter((r) => r.id !== id));
    router.refresh();
  }

  const responsesLink = (r: FormRow) => (
    <Link
      href={`/forms/${r.id}/responses`}
      className="text-xs text-accent hover:text-accent-bright"
      title="Read every answer people sent on this form"
    >
      {typeof responseCounts[r.id] === "number"
        ? `${responseCounts[r.id]} response${responseCounts[r.id] === 1 ? "" : "s"}`
        : "Responses (couldn't count)"}
    </Link>
  );

  // An intake form's switch reads Live / Disabled, as it always has. An offer's
  // reads On / Off: "Live" there means its PAGE is published.
  const onOff = (r: FormRow, labels: [string, string] = ["Live", "Disabled"]) =>
    canEdit ? (
      <button
        type="button"
        onClick={() => toggle(r.id, r.enabled)}
        className={`inline-flex items-center gap-1.5 text-xs ${r.enabled ? "text-status-engaged" : "text-fg-dim"}`}
      >
        {r.enabled ? <ToggleRight className="w-4 h-4" /> : <ToggleLeft className="w-4 h-4" />}
        {r.enabled ? labels[0] : labels[1]}
      </button>
    ) : (
      <span className={`text-xs ${r.enabled ? "text-status-engaged" : "text-fg-dim"}`}>{r.enabled ? labels[0] : labels[1]}</span>
    );

  const copyButton = (r: FormRow, what: "form" | "page" = "form") => (
    <button
      type="button"
      onClick={() => copyPublicUrl(r.id, r.slug, what)}
      disabled={!tenantSlug || !r.enabled}
      className="inline-flex items-center gap-1 text-fg-muted hover:text-fg text-xs disabled:opacity-40 disabled:cursor-not-allowed"
      title={
        !tenantSlug
          ? "Couldn't resolve your workspace - refresh and try again."
          : !r.enabled
            ? "Switch it on first - a switched-off form refuses public submissions."
            : what === "page"
              ? "Copy the landing page's link. Anyone with it sees this offer's page; a fresh lead is created on submit."
              : "Copy the public link. Anyone with it can open it; a fresh lead is created on submit."
      }
    >
      {copiedId === r.id ? (
        <>
          <Check className="w-3 h-3 text-status-engaged" />
          Copied
        </>
      ) : (
        <>
          <Copy className="w-3 h-3" />
          Copy link
        </>
      )}
    </button>
  );

  /**
   * An offer card's Preview: the public path with ?offer_preview=1. Rendered
   * ONLY for an editor on an enabled form (Codex review, PR #596):
   * resolvePublicForm 404s a switched-off form before preview authorization
   * ever runs, and the public route only honours offer_preview=1 for someone
   * canEdit - a read-only viewer who followed it would see the real public
   * page (live submission controls), never a draft preview.
   */
  const previewLink = (r: FormRow, label: "Open draft" | "Preview changes") => {
    if (!canEdit || !r.enabled) return null;
    const path = publicFormPath(r.slug);
    if (!path) return null;
    return (
      <a
        href={`${path}?offer_preview=1`}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1 text-fg-muted hover:text-fg text-xs"
        title="See the page as it is right now, draft changes included. Only you can open this."
      >
        <ExternalLink className="w-3 h-3" />
        {label}
      </a>
    );
  };

  /** Does this offer's public link show its landing page right now? */
  const pageIsPublic = (r: FormRow): boolean => {
    const status = offers?.[r.id]?.status;
    return r.enabled && (status === "live" || status === "live_with_changes");
  };

  /**
   * An offer card's link actions. ONE address, the landing page's:
   *   public -> Copy link, Open page, Share (tagged copies of that same page),
   *             plus Preview changes when a newer draft is waiting;
   *   draft  -> Open draft (the owner's preview) and Publish (the builder,
   *             whose checklist sits at the top). No Copy link: until Publish
   *             the address shows only the bare form, which is not the offer.
   */
  const offerLinkActions = (r: FormRow) => {
    // The offer's own short address (lib/offers/short-links.ts) when it has
    // one; the draft preview stays on the canonical /f/ path (previewLink).
    const path = offerShareablePath(tenantSlug, r.slug);
    if (!path) return null;
    if (pageIsPublic(r)) {
      return (
        <>
          {copyButton(r, "page")}
          <a
            href={path}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-fg-muted hover:text-fg text-xs"
            title="Open the live landing page, exactly as visitors see it."
          >
            <ExternalLink className="w-3 h-3" />
            Open page
          </a>
          {offers?.[r.id]?.status === "live_with_changes" ? previewLink(r, "Preview changes") : null}
          <ShareMenu path={path} onCopy={(key, text) => copyText(key, text)} copiedKey={copiedId} formId={r.id} />
        </>
      );
    }
    return (
      <>
        {previewLink(r, "Open draft")}
        {canEdit ? (
          <Link
            href={`/forms/${r.id}/edit`}
            className="inline-flex items-center gap-1 font-semibold text-accent hover:text-accent-bright text-xs"
            title="Open the builder: its checklist says what is left, then Publish makes this link show the page."
          >
            Publish
          </Link>
        ) : null}
      </>
    );
  };

  const actions = (r: FormRow, offer: boolean) => (
    <div className="inline-flex flex-wrap items-center gap-3">
      {canEdit && (
        <Link
          href={`/forms/${r.id}/edit`}
          className="inline-flex items-center gap-1 text-accent hover:text-accent-bright text-xs"
        >
          <Edit3 className="w-3 h-3" />
          Edit
        </Link>
      )}
      {offer ? offerLinkActions(r) : copyButton(r)}
      {offer ? responsesLink(r) : null}
      {canEdit && (
        <button
          type="button"
          onClick={() => destroy(r.id, r.name)}
          className="inline-flex items-center gap-1 text-rose-400 hover:text-rose-300 text-xs"
        >
          <Trash2 className="w-3 h-3" />
          Delete
        </button>
      )}
    </div>
  );

  // Every offer row as a card view model + its pre-built toggle/actions nodes
  // (OffersCardsClient lays these out; it owns no click handler of its own).
  const offerCards: OfferCardEntry[] = offerRows.map((r) => {
    const o = offers![r.id];
    const view: OfferCardViewModel = {
      id: r.id,
      name: r.name,
      slug: r.slug,
      headline: o.headline ?? null,
      subheadline: o.subheadline ?? null,
      hasVideo: o.hasVideo ?? false,
      status: o.status,
      publishedVersion: o.publishedVersion,
      leads: typeof recentLeads[r.id] === "number" ? recentLeads[r.id] : null,
      views: typeof recentFunnel[r.id]?.views === "number" ? recentFunnel[r.id].views : null,
      videoPlays: typeof recentFunnel[r.id]?.video_plays === "number" ? recentFunnel[r.id].video_plays : null,
      community: typeof recentFunnel[r.id]?.community === "number" ? recentFunnel[r.id].community : null,
      publicPath: offerShareablePath(tenantSlug, r.slug),
      linkState: !r.enabled ? "off" : pageIsPublic(r) ? "public" : "draft",
    };
    return { view, toggle: onOff(r, ["On", "Off"]), actions: actions(r, true) };
  });

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-xs text-fg-muted">
          {offerRows.length} offer{offerRows.length === 1 ? "" : "s"} - {intakeRows.length} intake form
          {intakeRows.length === 1 ? "" : "s"}
        </div>
        {canEdit ? (
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={createForm}
              disabled={creating}
              className="inline-flex items-center gap-2 rounded-lg border border-bg-border px-4 py-2 text-sm font-semibold text-fg-muted hover:text-fg hover:border-bg-border-strong disabled:opacity-50"
            >
              {creating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
              New intake form
            </button>
            <button
              type="button"
              onClick={() => setPicker("offer")}
              disabled={offers === null}
              title={offers === null ? "Offers aren't switched on in this workspace yet." : undefined}
              className="inline-flex items-center gap-2 rounded-lg bg-accent text-bg-deep px-4 py-2 text-sm font-bold hover:bg-accent-bright disabled:opacity-50"
            >
              <Plus className="w-4 h-4" />
              New offer
            </button>
          </div>
        ) : (
          <div className="text-xs text-fg-muted">
            {readOnlyNote ?? <>Only owners and admins can create or change forms. You can read every form&apos;s responses.</>}
          </div>
        )}
      </div>

      {savedFlash && (
        <div className="rounded-lg border border-status-engaged/40 bg-status-engaged/10 px-3 py-2 text-sm text-status-engaged flex items-center gap-2">
          <Check className="w-4 h-4" />
          Saved.
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-rose-500/40 bg-rose-500/10 p-3 text-sm text-rose-400">
          {error}
        </div>
      )}

      {/* -- Offers, as cards (R1) ---------------------------------------------- */}
      <section className="space-y-3">
        <h2 className="text-base font-bold text-fg">Offers</h2>
        <OffersCardsGrid
          cards={offerCards}
          canEdit={canEdit}
          offersEnabled={offers !== null}
          onCreateRouter={() => setPicker("router")}
        />
      </section>

      {/* -- Intake forms: plain table, visibly secondary to Offers above ------- */}
      <section className="space-y-3 pt-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-fg-muted">Intake forms</h2>
        {intakeRows.length === 0 ? (
          <div className="rounded-xl border border-bg-border bg-bg-elev/40 p-6 text-center text-fg-muted">
            <div className="text-sm">No intake forms.</div>
            {canEdit && (
              <div className="text-xs mt-1 text-fg-dim">
                <span className="text-fg">New intake form</span> makes a plain form with no page.
              </div>
            )}
          </div>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-bg-border">
            <table className="w-full text-sm">
              <thead className="bg-bg-elev/50">
                <tr className="text-left text-[10px] uppercase tracking-wider text-fg-dim">
                  <th className="px-4 py-2 font-bold">Name</th>
                  <th className="px-4 py-2 font-bold">Slug</th>
                  <th className="px-4 py-2 font-bold">Status</th>
                  <th className="px-4 py-2 font-bold">Responses</th>
                  <th className="px-4 py-2 font-bold text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-bg-border">
                {intakeRows.map((r) => (
                  <tr key={r.id} className="hover:bg-bg-elev/30">
                    <td className="px-4 py-3">
                      <div className="font-bold text-fg">{r.name}</div>
                      {r.description && (
                        <div className="text-xs text-fg-muted truncate max-w-md">
                          {r.description}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-fg-muted">{r.slug}</td>
                    <td className="px-4 py-3">{onOff(r)}</td>
                    <td className="px-4 py-3">{responsesLink(r)}</td>
                    <td className="px-4 py-3 text-right">{actions(r, false)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <div className="rounded-xl border border-bg-border bg-bg-elev/30 p-4 text-xs text-fg-muted leading-relaxed space-y-2">
        <div>
          <div className="font-bold text-fg mb-1 flex items-center gap-1.5">
            <ExternalLink className="w-3 h-3 text-accent" />
            Share link (anonymous)
          </div>
          The <span className="font-mono text-fg">Copy link</span> button on
          each row gives you a public URL anyone can open without an account.
          An offer&apos;s link shows its page once you publish it, and the plain
          form until then. A fresh lead is created the moment someone submits;
          their name, email, phone and company (if the form asks) seed the lead
          automatically.
        </div>
      </div>

      {picker ? (
        <NewOfferPicker
          routerMode={picker === "router"}
          profileSlug={profileSlug}
          tenantName={tenantName}
          tenantLogoUrl={tenantLogoUrl}
          onClose={() => setPicker(false)}
          onCreated={(id) => router.push(`/forms/${id}/edit`)}
        />
      ) : null}
    </div>
  );
}

/**
 * A public path as a full link for this browser. Call it from a click handler
 * only: a client component is rendered on the server first, where there is no
 * window, so reading the origin while rendering throws there.
 */
function absoluteUrl(path: string): string {
  return `${window.location.origin}${path}`;
}

/** The Share menu: the plain link, a link for a rep, and links tagged by channel. */
function ShareMenu({
  path,
  onCopy,
  copiedKey,
  formId,
}: {
  path: string | null;
  onCopy: (key: string, text: string) => void;
  copiedKey: string | null;
  formId: string;
}) {
  const [open, setOpen] = useState(false);
  const [rep, setRep] = useState("");
  if (!path) return null;
  const repCode = rep.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 40);
  return (
    <span className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="inline-flex items-center gap-1 text-fg-muted hover:text-fg text-xs"
      >
        <Share2 className="w-3 h-3" />
        Share
      </button>
      {open ? (
        <div className="absolute right-0 z-20 mt-2 w-72 rounded-xl border border-bg-border bg-bg-panel p-3 text-left shadow-elev">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[11px] font-bold text-fg">Share this offer</span>
            <button type="button" onClick={() => setOpen(false)} aria-label="Close" className="text-fg-dim hover:text-fg">
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          <ul className="space-y-1">
            <li>
              <button type="button" onClick={() => onCopy(`${formId}:plain`, absoluteUrl(path))} className="w-full rounded px-2 py-1.5 text-left text-xs text-fg hover:bg-bg-hover">
                {copiedKey === `${formId}:plain` ? "Copied" : "Plain link"}
              </button>
            </li>
            {SHARE_PRESETS.map((p) => (
              <li key={p.label}>
                <button
                  type="button"
                  onClick={() => onCopy(`${formId}:${p.label}`, `${absoluteUrl(path)}?${p.params}`)}
                  className="w-full rounded px-2 py-1.5 text-left text-xs text-fg hover:bg-bg-hover"
                >
                  {copiedKey === `${formId}:${p.label}` ? "Copied" : `${p.label} link`}
                </button>
              </li>
            ))}
          </ul>
          <div className="mt-3 border-t border-bg-border pt-3">
            <label className="block text-[11px] text-fg-muted">
              Link for a rep (their rep code)
              <input
                value={rep}
                onChange={(e) => setRep(e.target.value)}
                className="input mt-1 w-full text-xs"
                placeholder="e.g. jordan"
              />
            </label>
            <button
              type="button"
              disabled={!repCode}
              onClick={() => onCopy(`${formId}:rep`, `${absoluteUrl(path)}?rep=${encodeURIComponent(repCode)}`)}
              className="mt-2 w-full rounded border border-bg-border px-2 py-1.5 text-xs text-fg hover:bg-bg-hover disabled:opacity-40"
            >
              {copiedKey === `${formId}:rep` ? "Copied" : "Copy rep link"}
            </button>
          </div>
          <p className="mt-3 text-[10px] leading-relaxed text-fg-dim">
            Channel links carry a source tag. Offers starts counting them by source in the next update.
          </p>
        </div>
      ) : null}
    </span>
  );
}

/**
 * New offer: a template (structure only), the offer's name, its link name.
 *
 * ROUTER MODE (Codex review, PR #596). Opened from the "Start here" empty
 * state, this same picker must land on slug "vsl" exactly - the one slug
 * OffersCardsGrid recognises as the router card. The ordinary flow derives
 * the link name from the typed offer name, which essentially never spells
 * "vsl", so completing it used to create another regular offer and leave the
 * empty state showing. In router mode the link name is fixed, shown as
 * read-only text rather than an input the visitor could still change, and
 * `offerCreateSlug`/`slugTakenMessage` (lib/offers/router-create.ts) are the
 * only two places that decide what gets submitted and what a collision
 * means - kept out of this component so the rule is unit-testable without a
 * browser.
 */
function NewOfferPicker({
  routerMode,
  profileSlug,
  tenantName,
  tenantLogoUrl,
  onClose,
  onCreated,
}: {
  routerMode: boolean;
  profileSlug: string | null;
  tenantName: string | null;
  tenantLogoUrl: string | null;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [template, setTemplate] = useState<TemplateKey>("book_call");
  const [name, setName] = useState(routerMode ? "Start here" : "");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const typedSlug = slugTouched ? slug : slugify(name);
  const linkName = offerCreateSlug(routerMode, typedSlug);

  async function create() {
    setError(null);
    if (!name.trim()) return setError("Give the offer a name.");
    if (!SLUG_RE.test(linkName)) return setError("The link name needs at least two letters or numbers, with dashes between words.");
    setBusy(true);
    try {
      // The template's form steps, in the workspace's own look. No headline: the
      // page's headline is written in the builder, never borrowed.
      const starter = starterFormForTenant(profileSlug, tenantName, tenantLogoUrl);
      const branding = { ...starter.branding };
      delete branding.headline;
      delete branding.subheadline;
      const res = await fetch("/api/forms", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          slug: linkName,
          name: name.trim(),
          branding,
          steps: starterStepsForTemplate(template),
          step_outcomes: {},
          enabled: true,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; form?: { id: string }; error?: string; message?: string };
      if (!data.ok || !data.form) {
        setError(data.error === "slug_taken" ? slugTakenMessage(routerMode) : data.message || "Couldn't create the offer. Try again in a moment.");
        return;
      }
      const page = await fetch(`/api/forms/${data.form.id}/offer`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ template }),
      });
      const made = (await page.json().catch(() => ({}))) as { ok?: boolean; message?: string; error?: string };
      if (!made.ok) {
        setError(made.message || "The form was made, but its page wasn't. Open the form from the list and choose Turn into an offer.");
        return;
      }
      onCreated(data.form.id);
    } catch {
      setError("Couldn't create the offer: the connection dropped. Check it and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={routerMode ? "New start-here page" : "New offer"}
    >
      <div className="w-full max-w-2xl rounded-2xl border border-bg-border bg-bg-panel p-6 shadow-elev">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-bold text-fg">{routerMode ? "New start-here page" : "New offer"}</h2>
            <p className="mt-1 text-sm text-fg-muted">
              {routerMode
                ? `This is the first page a new visitor sees, before they land on one of your offers. Its link is fixed at /${ROUTER_SLUG} so it can be pinned above Offers.`
                : "A full page with your form inside. Templates set the sections only; every word is yours to write."}
            </p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="text-fg-dim hover:text-fg">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="mt-5 grid gap-3 sm:grid-cols-3">
          {OFFER_TEMPLATES.map((t) => (
            <button
              type="button"
              key={t.key}
              onClick={() => setTemplate(t.key)}
              aria-pressed={template === t.key}
              className={`rounded-xl border p-4 text-left transition-colors ${
                template === t.key ? "border-accent bg-accent/10" : "border-bg-border hover:border-bg-border-strong"
              }`}
            >
              <div className="text-sm font-bold text-fg">{t.label}</div>
              <div className="mt-1 text-xs leading-relaxed text-fg-muted">{t.summary}</div>
            </button>
          ))}
        </div>

        <div className="mt-5 grid gap-4 sm:grid-cols-2">
          <label className="block text-xs text-fg-muted">
            {routerMode ? "Page name (only your team sees it)" : "Offer name (only your team sees it)"}
            <input value={name} onChange={(e) => setName(e.target.value)} className="input mt-1 w-full" maxLength={120} />
          </label>
          {routerMode ? (
            <div className="block text-xs text-fg-muted">
              Link name (fixed)
              <div className="input mt-1 flex w-full items-center font-mono text-fg-dim" aria-readonly="true">
                /{ROUTER_SLUG}
              </div>
            </div>
          ) : (
            <label className="block text-xs text-fg-muted">
              Link name (can&apos;t be changed later)
              <input
                value={linkName}
                onChange={(e) => {
                  setSlugTouched(true);
                  setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 63));
                }}
                className="input mt-1 w-full font-mono"
                maxLength={63}
              />
            </label>
          )}
        </div>

        {error ? <div className="mt-4 rounded-lg border border-rose-500/40 bg-rose-500/10 p-3 text-sm text-rose-400">{error}</div> : null}

        <div className="mt-6 flex items-center justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-lg px-4 py-2 text-sm text-fg-muted hover:text-fg">
            Cancel
          </button>
          <button
            type="button"
            onClick={create}
            disabled={busy}
            className="inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-bold text-bg-deep hover:bg-accent-bright disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {routerMode ? "Create the start-here page" : "Create the offer"}
          </button>
        </div>
        <p className="mt-3 text-[11px] text-fg-dim">
          The page goes public when you press Publish. Until then its link shows only a plain form, titled with your
          workspace&apos;s name, never this offer&apos;s name.
        </p>
      </div>
    </div>
  );
}
