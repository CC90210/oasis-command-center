"use client";

/**
 * OfferBuilder - /forms/[id]/edit for a form with an offer page (design 2.2).
 *
 * Tabs: Page / Video / Form & booking / Settings / Preview. The draft saves
 * itself a moment after each change (compare-and-swap on its version, so two
 * owners editing at once never overwrite each other silently). The public page
 * changes only when someone presses Publish, and only once the checklist is
 * clear. Unpublish turns the link back into the plain form at once.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ExternalLink, Loader2 } from "lucide-react";
import { FormBuilderClient } from "@/components/forms/FormBuilderClient";
import type { FormBranding, FormStep } from "@/lib/forms/types";
import type { BodyKey, BodySection, OfferPageDoc } from "@/lib/offer-pages/types";
import { BODY_KEYS, COPY_CAPS, accentPassesAA, isHexColor } from "@/lib/offer-pages/types";
import { NAV_LABELS, drawnSections } from "@/lib/offer-pages/visibility";
import type { GateResult } from "@/lib/offer-pages/claims";
import { serialSaver } from "@/lib/offer-pages/save-queue";
import { fieldLabel } from "@/lib/offer-pages/field-labels";
import { BookEditor, BriefEditor, HeroEditor, SectionCard, newSection, type ChipState } from "./SectionEditors";
import { PublishChecklist } from "./PublishChecklist";
import { VideoPicker } from "./VideoPicker";
import { TextField, Tick } from "./fields";

type OfferView = {
  template: string;
  draft: OfferPageDoc | null;
  draft_error: string | null;
  version: number;
  live: boolean;
  status: "live" | "live_with_changes" | "draft";
  published_version: number;
  gate: GateResult | null;
};

type FormRecord = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  branding: FormBranding;
  steps: FormStep[];
  on_complete_stage: string | null;
  step_outcomes: Record<string, string>;
  enabled: boolean;
  redirect_url: string | null;
};

const TABS = ["Page", "Video", "Form & booking", "Settings", "Preview"] as const;
type Tab = (typeof TABS)[number];

/** For the status chips only: the builder cannot check a Library asset, so it assumes one resolves. */
const LENIENT_MEDIA = { video: () => true, image: () => true };

function wordCount(s: string): number {
  return s.trim() ? s.trim().split(/\s+/).length : 0;
}

export function OfferBuilder({
  form,
  profileSlug,
  initial,
  tenantSlug,
  alert,
  libraryAvailable,
  bookingLinkSet,
  canRequestCopy,
}: {
  form: FormRecord;
  profileSlug: string | null;
  initial: OfferView;
  tenantSlug: string | null;
  alert: { connected: boolean; line: string };
  libraryAvailable: boolean;
  bookingLinkSet: boolean;
  /** OASIS's own workspace: "Ask for copy" flags the brief for the copy team. */
  canRequestCopy: boolean;
}) {
  const [tab, setTab] = useState<Tab>("Page");
  const [doc, setDoc] = useState<OfferPageDoc | null>(initial.draft);
  const [view, setView] = useState<OfferView>(initial);
  const [saving, setSaving] = useState<"idle" | "pending" | "saving" | "saved" | "error">("idle");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [publishErrors, setPublishErrors] = useState<string[]>([]);
  const [previewWidth, setPreviewWidth] = useState<"desktop" | "phone">("desktop");
  const [previewKey, setPreviewKey] = useState(0);
  // The accent's text box holds what is typed, one character at a time; the
  // page takes it only once it is a whole colour (or emptied).
  const [accentText, setAccentText] = useState(initial.draft?.theme.accent ?? "");
  const versionRef = useRef(initial.version);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingTicks = useRef<{ confirm: string[]; unconfirm: string[] }>({ confirm: [], unconfirm: [] });
  const conflict = useRef(false);

  /** One draft save; true only when the server took it. */
  const saveOnce = useCallback(async (next: OfferPageDoc): Promise<boolean> => {
    if (conflict.current) return false;
    setSaving("saving");
    const ticks = pendingTicks.current;
    pendingTicks.current = { confirm: [], unconfirm: [] };
    try {
      const res = await fetch(`/api/forms/${form.id}/offer`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ draft: next, version: versionRef.current, confirm_claims: ticks.confirm, unconfirm_claims: ticks.unconfirm }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; offer?: OfferView; error?: string; message?: string; path?: string; reason?: string };
      if (!data.ok || !data.offer) {
        if (data.error === "draft_conflict") conflict.current = true;
        setSaving("error");
        setSaveError(
          data.message ||
            (data.error === "invalid_page"
              ? `Not saved. ${fieldLabel(data.path, next)}: ${data.reason ?? "needs a change"}.`
              : "Not saved. Try again in a moment."),
        );
        return false;
      }
      versionRef.current = data.offer.version;
      setView(data.offer);
      setSaving("saved");
      setSaveError(null);
      return true;
    } catch {
      setSaving("error");
      setSaveError("Not saved: the connection dropped. Your changes are still here; they save on the next edit.");
      return false;
    }
  }, [form.id]);
  // One save at a time (lib/offer-pages/save-queue.ts): each sends the version
  // the last one returned, so two in flight would read as someone else's edit.
  const saver = useMemo(() => serialSaver(saveOnce), [saveOnce]);
  const save = saver.save;

  const update = useCallback(
    (next: OfferPageDoc) => {
      setDoc(next);
      setSaving("pending");
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void save(next), 900);
    },
    [save],
  );

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const chips = useMemo(() => {
    const out: Partial<Record<BodyKey, ChipState>> = {};
    if (!doc) return out;
    const drawn = new Set(drawnSections(doc, LENIENT_MEDIA).map((s) => s.key));
    const needsOk = new Set((view.gate?.claims ?? []).filter((c) => !c.confirmed).map((c) => c.section));
    for (const s of doc.sections) out[s.key] = !drawn.has(s.key) ? "hidden" : needsOk.has(s.key) ? "needs_ok" : "ready";
    return out;
  }, [doc, view.gate]);

  if (!doc) {
    return (
      <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 p-4 text-sm text-rose-400">
        This offer page&apos;s saved draft can&apos;t be read ({view.draft_error}). Nothing public changed. Ask the
        workspace owner to contact support.
      </div>
    );
  }

  const setSection = (i: number, s: BodySection) => update({ ...doc, sections: doc.sections.map((x, j) => (j === i ? s : x)) });
  const missing = BODY_KEYS.filter((k) => !doc.sections.some((s) => s.key === k));
  const publicPath = tenantSlug ? `/f/${tenantSlug}/${form.slug}` : null;

  async function tick(hash: string, confirmed: boolean) {
    if (!doc) return;
    if (confirmed) pendingTicks.current.confirm.push(hash);
    else pendingTicks.current.unconfirm.push(hash);
    if (timer.current) clearTimeout(timer.current);
    await save(doc);
  }

  async function publish() {
    setBusy(true);
    setPublishErrors([]);
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
      if (doc) await save(doc);
    }
    // A save already on its way moves the version on: publish the one it returns,
    // and only once it landed. A refused or dropped save leaves the stored draft
    // older than what the editor shows, and that older draft must not go live.
    if (!(await saver.idle())) {
      setPublishErrors(["Your latest changes aren't saved, so nothing was published. Fix what the message at the top says, then publish."]);
      setBusy(false);
      return;
    }
    try {
      const res = await fetch(`/api/forms/${form.id}/offer/publish`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ version: versionRef.current }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; offer?: OfferView; blockers?: string[]; message?: string };
      if (!data.ok) {
        setPublishErrors(data.blockers?.length ? data.blockers : [data.message || "Not published. Try again."]);
        return;
      }
      if (data.offer) setView(data.offer);
      setPreviewKey((k) => k + 1);
    } finally {
      setBusy(false);
    }
  }

  async function unpublish() {
    setBusy(true);
    try {
      const res = await fetch(`/api/forms/${form.id}/offer/unpublish`, { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; offer?: OfferView };
      if (data.ok && data.offer) setView(data.offer);
    } finally {
      setBusy(false);
    }
  }

  const accent = doc.theme.accent ?? "";
  const accentOk = !accent || accentPassesAA(accent);
  const accentTyped = accentText.trim();
  const accentPartial = accentTyped !== "" && !isHexColor(accentTyped);
  const script = doc.hero.vsl_script?.text ?? "";
  const words = wordCount(script);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3 text-xs text-fg-muted">
        <span>
          {saving === "saving" ? (
            <span className="inline-flex items-center gap-1">
              <Loader2 className="h-3 w-3 animate-spin" /> Saving
            </span>
          ) : saving === "pending" ? (
            "Changes not saved yet"
          ) : saving === "saved" ? (
            "Draft saved"
          ) : saving === "error" ? (
            <span className="text-rose-400">{saveError}</span>
          ) : (
            "Draft"
          )}
        </span>
        {publicPath ? (
          <a href={publicPath} target="_blank" rel="noopener noreferrer" className="ml-auto inline-flex items-center gap-1 text-accent hover:text-accent-bright">
            Open the public link <ExternalLink className="h-3 w-3" />
          </a>
        ) : null}
      </div>

      <PublishChecklist
        gate={view.gate}
        status={view.status}
        publishedVersion={view.published_version}
        alertLine={alert.line}
        alertConnected={alert.connected}
        busy={busy}
        onTick={(h, c) => void tick(h, c)}
        onPublish={() => void publish()}
        onUnpublish={() => void unpublish()}
        publishErrors={publishErrors}
      />

      <div role="tablist" aria-label="Offer builder" className="flex flex-wrap gap-1 border-b border-bg-border">
        {TABS.map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm ${tab === t ? "border-accent text-fg" : "border-transparent text-fg-muted hover:text-fg"}`}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === "Page" ? (
        <div className="space-y-4">
          <div className="rounded-xl border border-bg-border bg-bg-elev/40 p-4">
            <div className="mb-3 text-sm font-bold text-fg">Top of the page</div>
            <HeroEditor hero={doc.hero} onChange={(hero) => update({ ...doc, hero })} />
          </div>
          {doc.sections.map((s, i) => (
            <SectionCard
              key={s.key}
              section={s}
              index={i}
              count={doc.sections.length}
              pinned={doc.nav.pinned.includes(s.key)}
              chip={chips[s.key] ?? "hidden"}
              formId={form.id}
              libraryAvailable={libraryAvailable}
              onChange={(next) => setSection(i, next)}
              onMove={(by) => {
                const j = i + by;
                if (j < 0 || j >= doc.sections.length) return;
                const sections = [...doc.sections];
                [sections[i], sections[j]] = [sections[j], sections[i]];
                update({ ...doc, sections });
              }}
              onRemove={() =>
                update({
                  ...doc,
                  sections: doc.sections.filter((_, j) => j !== i),
                  nav: { ...doc.nav, pinned: doc.nav.pinned.filter((k) => k !== s.key) },
                })
              }
              onTogglePin={() =>
                update({
                  ...doc,
                  nav: {
                    ...doc.nav,
                    pinned: doc.nav.pinned.includes(s.key) ? doc.nav.pinned.filter((k) => k !== s.key) : [...doc.nav.pinned, s.key],
                  },
                })
              }
            />
          ))}
          {missing.length ? (
            <div className="flex flex-wrap items-center gap-2 text-xs text-fg-muted">
              Add a section:
              {missing.map((k) => (
                <button
                  key={k}
                  type="button"
                  className="rounded-full border border-bg-border px-2.5 py-0.5 hover:border-accent hover:text-fg"
                  onClick={() => update({ ...doc, sections: [...doc.sections, newSection(k)] })}
                >
                  {NAV_LABELS[k]}
                </button>
              ))}
            </div>
          ) : null}
          <div className="rounded-xl border border-bg-border bg-bg-elev/40 p-4">
            <div className="mb-3 text-sm font-bold text-fg">Book (always last)</div>
            <BookEditor book={doc.book} bookingLinkSet={bookingLinkSet} onChange={(book) => update({ ...doc, book })} />
          </div>
          <div className="rounded-xl border border-bg-border bg-bg-elev/40 p-4">
            <div className="mb-3 text-sm font-bold text-fg">Copy brief</div>
            <BriefEditor brief={doc.brief} canRequest={canRequestCopy} onChange={(brief) => update({ ...doc, brief })} />
          </div>
        </div>
      ) : null}

      {tab === "Video" ? (
        <div className="space-y-4 rounded-xl border border-bg-border bg-bg-elev/40 p-4">
          <div className="text-sm font-bold text-fg">The video at the top (VSL)</div>
          <VideoPicker
            formId={form.id}
            label="Top video"
            value={doc.hero.video ?? null}
            libraryAvailable={libraryAvailable}
            onChange={(video) => update({ ...doc, hero: { ...doc.hero, video } })}
          />
          {!libraryAvailable ? <p className="text-[12px] text-fg-dim">Attach your video by link: YouTube, Vimeo or Loom.</p> : null}
          <TextField
            label="The video's script"
            value={script}
            cap={COPY_CAPS.vsl_script}
            multiline
            rows={10}
            hint={words ? `${words} words, about ${Math.max(1, Math.round(words / 150))} min spoken` : "Paste the script the video follows."}
            onChange={(v) => update({ ...doc, hero: { ...doc.hero, vsl_script: v.trim() ? { text: v, source: doc.hero.vsl_script?.source ?? "cc" } : null } })}
          />
          <div className="flex flex-wrap items-center gap-4">
            <button
              type="button"
              className="btn-secondary !px-3 !py-1.5 text-xs"
              disabled={!script.trim()}
              onClick={() => void navigator.clipboard?.writeText(script).catch(() => undefined)}
            >
              Copy for teleprompter
            </button>
            <Tick checked={!!doc.hero.show_transcript} onChange={(v) => update({ ...doc, hero: { ...doc.hero, show_transcript: v } })}>
              Show the script under the video as a transcript
            </Tick>
          </div>
        </div>
      ) : null}

      {tab === "Form & booking" ? (
        <div className="space-y-4">
          <p className="text-[13px] text-fg-muted">
            The form below is the page&apos;s Book section. Save it here; the page uses it straight away.
          </p>
          <FormBuilderClient initialForm={form} profileSlug={profileSlug} />
        </div>
      ) : null}

      {tab === "Settings" ? (
        <div className="space-y-4 rounded-xl border border-bg-border bg-bg-elev/40 p-4">
          <label className="block space-y-1">
            <span className="label">Accent colour</span>
            <div className="flex items-center gap-3">
              <input
                type="color"
                value={isHexColor(accent) ? accent : "#00D4FF"}
                onChange={(e) => {
                  const picked = e.target.value.toUpperCase();
                  setAccentText(picked);
                  update({ ...doc, theme: { ...doc.theme, accent: picked } });
                }}
                className="h-9 w-12 rounded border border-bg-border bg-transparent"
                aria-label="Pick the accent colour"
              />
              <input
                className="input w-32 font-mono"
                value={accentText}
                placeholder="#00D4FF"
                aria-label="The accent colour as a code"
                onChange={(e) => {
                  setAccentText(e.target.value);
                  const v = e.target.value.trim();
                  if (!v || isHexColor(v)) update({ ...doc, theme: { ...doc.theme, accent: v ? v.toUpperCase() : undefined } });
                }}
              />
              <span className={`text-[12px] ${accentPartial ? "text-status-warm" : accentOk ? "text-fg-dim" : "text-rose-400"}`}>
                {accentPartial
                  ? "Type the whole colour, like #E8C547."
                  : accentOk
                    ? "Readable on the page."
                    : "Too dark to read on the page. Pick a lighter colour."}
              </span>
            </div>
          </label>
          <Tick
            checked={doc.theme.logo !== "none"}
            onChange={(v) => update({ ...doc, theme: { ...doc.theme, logo: v ? "workspace" : "none" } })}
          >
            Show your workspace logo in the header
          </Tick>
          <TextField
            label="Header button label"
            value={doc.nav.cta_label}
            cap={COPY_CAPS.cta_label}
            placeholder="Book a call"
            onChange={(v) => update({ ...doc, nav: { ...doc.nav, cta_label: v } })}
          />
          <TextField
            label="Browser tab and link preview title"
            value={doc.seo.title}
            cap={COPY_CAPS.seo_title}
            onChange={(v) => update({ ...doc, seo: { ...doc.seo, title: v } })}
          />
          <TextField
            label="Link preview description"
            value={doc.seo.description}
            cap={COPY_CAPS.seo_description}
            multiline
            rows={2}
            onChange={(v) => update({ ...doc, seo: { ...doc.seo, description: v } })}
          />
          <p className="text-[12px] text-fg-dim">Offer pages stay out of search results.</p>
        </div>
      ) : null}

      {tab === "Preview" ? (
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-xs">
            {(["desktop", "phone"] as const).map((w) => (
              <button
                key={w}
                type="button"
                onClick={() => setPreviewWidth(w)}
                className={`rounded-full border px-3 py-1 ${previewWidth === w ? "border-accent text-fg" : "border-bg-border text-fg-muted"}`}
              >
                {w === "desktop" ? "Desktop" : "Phone"}
              </button>
            ))}
            <button type="button" onClick={() => setPreviewKey((k) => k + 1)} className="ml-auto text-fg-muted hover:text-fg">
              Reload the preview
            </button>
          </div>
          {!form.enabled ? (
            <p className="text-[13px] text-status-warm">Switch the form on to preview its page.</p>
          ) : publicPath ? (
            <div className="flex justify-center rounded-xl border border-bg-border bg-bg-deep p-3">
              <iframe
                key={previewKey}
                title="Preview of the offer page"
                src={`${publicPath}?offer_preview=1`}
                className="h-[78vh] rounded-lg border border-bg-border bg-black"
                style={{ width: previewWidth === "phone" ? 390 : "100%" }}
              />
            </div>
          ) : null}
          <p className="text-[12px] text-fg-dim">The preview shows your saved draft. Only you and other owners can see it; it never sends anything.</p>
        </div>
      ) : null}
    </div>
  );
}
