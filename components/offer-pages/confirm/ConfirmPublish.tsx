"use client";

/**
 * ConfirmPublish - /forms/publish: every offer page's sign-offs on one screen,
 * then Publish.
 *
 * CC 2026-10-16: one screen, no manual video uploads. Six offer pages sat as
 * drafts, each behind its own builder with its own ticks, and every top video
 * had to be found and attached by hand. Here each page is one card: the
 * sentences that make a claim, the prices, the guarantee, the proposed top
 * video (watch it, tick once), the form's switch, and Save / Publish. "Publish
 * all ready" at the top publishes every page that has nothing left to tick.
 *
 * Nothing is ticked for the owner: a box shows ticked only when an owner
 * already confirmed it. Every action goes through the routes the builder and
 * the Library use (lib/offer-pages/confirm-publish.ts lists them), and the
 * server stamps who confirmed what. After an action the page is read again
 * (router.refresh), so each card shows the server's state, not a guess.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { AlertTriangle, CheckCircle2, ExternalLink, Film, Loader2, Play } from "lucide-react";
import { pendingConfirmation } from "@/components/offer-pages/builder/fields";
import type { Aspect } from "@/lib/offer-pages/types";
import {
  groupClaims,
  hasChanges,
  initialChoices,
  isReady,
  needsPublish,
  outcomeWords,
  publishOffer,
  saveOffer,
  videoTickable,
  whatBlocks,
  type ActionDeps,
  type ActionOutcome,
  type Choices,
  type ConfirmOffer,
} from "@/lib/offer-pages/confirm-publish";

const STATUS_WORDS: Record<ConfirmOffer["status"], string> = {
  live: "Live",
  live_with_changes: "Live, with newer changes",
  draft: "Draft",
};

/** A Library status, in the owner's words. */
function libraryStatusWords(status: string): string {
  switch (status) {
    case "in_review":
      return "waiting for review";
    case "draft":
      return "a draft";
    case "scheduled":
      return "scheduled";
    case "rejected":
      return "rejected";
    case "archived":
      return "archived";
    default:
      return status || "unknown";
  }
}

/** The state a card's ticks start from, per page: changes when the page itself changed on the server. */
const stampOf = (o: ConfirmOffer) => `${o.version}|${o.status}|${o.formEnabled}|${o.proposal.state === "ready" ? `${o.proposal.status}|${o.proposal.onPage}` : o.proposal.state}`;

export function ConfirmPublish({ offers }: { offers: ConfirmOffer[] }) {
  const router = useRouter();
  const [choices, setChoices] = useState<Record<string, Choices>>(() => Object.fromEntries(offers.map((o) => [o.formId, initialChoices(o)])));
  const [outcomes, setOutcomes] = useState<Record<string, ActionOutcome>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [allBusy, setAllBusy] = useState(false);
  const stamps = useRef<Record<string, string>>(Object.fromEntries(offers.map((o) => [o.formId, stampOf(o)])));

  // After a refresh, a page the server changed starts again from the server's
  // ticks; a page that did not change keeps what the owner has ticked so far.
  // Which pages changed is decided here, once: the updater below stays pure, since
  // React may call it twice (StrictMode, a rebased update) and a second call
  // must not read a stamp the first one wrote.
  useEffect(() => {
    const changed = new Set(offers.filter((o) => stamps.current[o.formId] !== stampOf(o)).map((o) => o.formId));
    stamps.current = Object.fromEntries(offers.map((o) => [o.formId, stampOf(o)]));
    setChoices((prev) => {
      const next: Record<string, Choices> = {};
      for (const o of offers) next[o.formId] = !changed.has(o.formId) && prev[o.formId] ? prev[o.formId] : initialChoices(o);
      return next;
    });
  }, [offers]);

  const deps = useMemo<ActionDeps>(() => ({ fetch: (url, init) => fetch(url, init), pending: pendingConfirmation }), []);
  const choiceOf = (o: ConfirmOffer) => choices[o.formId] ?? initialChoices(o);
  const ready = offers.filter((o) => isReady(o, choiceOf(o)) && needsPublish(o, choiceOf(o)));

  function setChoice(formId: string, change: (c: Choices) => Choices) {
    setChoices((prev) => {
      const o = offers.find((x) => x.formId === formId);
      if (!o) return prev;
      return { ...prev, [formId]: change(prev[formId] ?? initialChoices(o)) };
    });
  }

  async function run(o: ConfirmOffer, action: "save" | "publish"): Promise<ActionOutcome> {
    setBusy((b) => ({ ...b, [o.formId]: true }));
    try {
      const c = choiceOf(o);
      const outcome = action === "save" ? await saveOffer(o, c, deps) : await publishOffer(o, c, deps);
      setOutcomes((prev) => ({ ...prev, [o.formId]: outcome }));
      return outcome;
    } finally {
      setBusy((b) => ({ ...b, [o.formId]: false }));
    }
  }

  async function one(o: ConfirmOffer, action: "save" | "publish") {
    await run(o, action);
    router.refresh();
  }

  async function publishAll() {
    setAllBusy(true);
    try {
      // One at a time: each page is its own save and publish, and a refusal on
      // one never stops the rest.
      for (const o of ready) await run(o, "publish");
    } finally {
      setAllBusy(false);
      router.refresh();
    }
  }

  if (!offers.length) {
    return (
      <p className="rounded-xl border border-bg-border bg-bg-elev/40 p-4 text-[13px] text-fg-muted">
        No offer pages in this workspace yet. Make one with New offer on the Offers screen.
      </p>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-bg-border bg-bg-elev/40 p-4">
        <p className="text-[13px] text-fg">
          {ready.length === 1 ? "1 page is ready to publish." : `${ready.length} pages are ready to publish.`}{" "}
          <span className="text-fg-muted">Tick what is true below. Publish switches each page&apos;s form on for you.</span>
        </p>
        <button
          type="button"
          className="btn-primary ml-auto inline-flex min-h-11 items-center gap-2 !px-4 text-sm"
          disabled={allBusy || ready.length === 0 || Object.values(busy).some(Boolean)}
          onClick={() => void publishAll()}
        >
          {allBusy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
          Publish all ready ({ready.length})
        </button>
      </div>

      {offers.map((o) => (
        <OfferConfirmCard
          key={o.formId}
          offer={o}
          choices={choiceOf(o)}
          outcome={outcomes[o.formId] ?? null}
          busy={!!busy[o.formId] || allBusy}
          onChange={(change) => setChoice(o.formId, change)}
          onSave={() => void one(o, "save")}
          onPublish={() => void one(o, "publish")}
        />
      ))}
    </div>
  );
}

function OfferConfirmCard({
  offer: o,
  choices: c,
  outcome,
  busy,
  onChange,
  onSave,
  onPublish,
}: {
  offer: ConfirmOffer;
  choices: Choices;
  outcome: ActionOutcome | null;
  busy: boolean;
  onChange: (change: (c: Choices) => Choices) => void;
  onSave: () => void;
  onPublish: () => void;
}) {
  const headingId = `confirm-${o.formId}`;
  const blocks = whatBlocks(o, c);
  const ready = isReady(o, c);
  const changed = hasChanges(o, c);
  const words = outcome ? outcomeWords(outcome) : null;

  return (
    <section aria-labelledby={headingId} className="space-y-4 rounded-xl border border-bg-border bg-bg-elev/40 p-4" data-offer={o.slug}>
      <header className="flex flex-wrap items-start gap-3">
        <div className="min-w-0">
          <h2 id={headingId} className="text-base font-semibold text-fg">
            {o.name}
          </h2>
          <p className="mt-0.5 font-mono text-[12px] text-fg-muted">{o.link ?? "No public link: the workspace's address could not be read."}</p>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2 text-[12px]">
          <span className={`rounded-md border px-2 py-1 ${o.formEnabled ? "border-status-engaged/40 text-status-engaged" : "border-bg-border text-fg-muted"}`}>
            {o.formEnabled ? "Form on" : "Form off"}
          </span>
          <span className={`rounded-md border px-2 py-1 ${o.status === "draft" ? "border-bg-border text-fg-muted" : "border-status-engaged/40 text-status-engaged"}`}>
            {STATUS_WORDS[o.status]}
          </span>
          {o.previewPath ? (
            // The whole page as it will look, its unconfirmed prices marked: read it before ticking.
            <a
              href={o.previewPath}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex min-h-11 items-center gap-1 px-2 text-accent hover:text-accent-bright"
            >
              Preview the whole page <ExternalLink className="h-3 w-3" aria-hidden="true" />
            </a>
          ) : null}
          <Link href={`/forms/${encodeURIComponent(o.formId)}/edit`} className="inline-flex min-h-11 items-center gap-1 px-2 text-accent hover:text-accent-bright">
            Open the builder <ExternalLink className="h-3 w-3" aria-hidden="true" />
          </Link>
        </div>
      </header>

      {blocks.length ? (
        <div className="space-y-1.5" data-blockers="">
          <p className="text-[12px] font-semibold text-fg">Still to do before this page can go live</p>
          <ul className="space-y-1">
            {blocks.map((b) => (
              <li key={b} className="flex items-start gap-2 text-[13px] text-status-warm">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                {b}
              </li>
            ))}
          </ul>
          {o.unfixable.length ? <p className="text-[12px] text-fg-muted">Fix the last points in the builder, then come back.</p> : null}
        </div>
      ) : (
        <p className="flex items-center gap-2 text-[13px] text-status-engaged" data-ready="">
          <CheckCircle2 className="h-4 w-4" aria-hidden="true" /> Ready to publish.
        </p>
      )}

      {o.warnings.length ? (
        <div className="space-y-1.5" data-warnings="">
          <p className="text-[12px] font-semibold text-fg">Worth a look before publishing</p>
          <ul className="space-y-1">
            {o.warnings.map((w) => (
              <li key={w} className="flex items-start gap-2 text-[13px] text-fg-muted">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                {w}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {!o.formEnabled ? (
        <p className="text-[13px] text-fg-muted">Switch the form on: Publish does it for you. The page&apos;s Book section is the form.</p>
      ) : null}

      {o.claims.length ? (
        <Group title="Sentences that make a claim" hint="Tick each one that is true and that you can back.">
          {groupClaims(o.claims).map((g) => (
            <div key={g.section} className="space-y-1">
              <p className="text-[12px] text-fg-muted">{g.label}</p>
              {g.items.map((item) => (
                <TickRow
                  key={item.hash}
                  checked={!!c.claims[item.hash]}
                  disabled={busy}
                  label={`True, and we can back it: ${item.sentence}`}
                  onChange={(v) => onChange((x) => ({ ...x, claims: { ...x.claims, [item.hash]: v } }))}
                >
                  <span className="block">{item.sentence}</span>
                  <span className="block text-[12px] text-fg-muted">True, and we can back it. ({item.why.join(", ")})</span>
                </TickRow>
              ))}
            </div>
          ))}
        </Group>
      ) : null}

      {o.prices.length ? (
        <Group title="Prices" hint="Each one is shown on the page exactly as written.">
          {o.prices.map((p) => (
            <TickRow
              key={p.index}
              checked={!!c.prices[p.index]}
              disabled={busy}
              label={`I confirm this price is right: ${p.name}, ${p.shown}`}
              onChange={(v) => onChange((x) => ({ ...x, prices: { ...x.prices, [p.index]: v } }))}
            >
              I confirm this price is right. {p.name}: {p.shown}
            </TickRow>
          ))}
        </Group>
      ) : null}

      {o.bonusValues.length ? (
        <Group title="Bonus values" hint="A bonus value is only ever saved with an owner's confirmation. Change one in the builder.">
          {o.bonusValues.map((b) => (
            <p key={b.index} className="flex min-h-11 items-center gap-2 px-2 text-[13px] text-fg">
              <CheckCircle2 className="h-4 w-4 shrink-0 text-status-engaged" aria-hidden="true" />
              {b.title}: {b.value}, confirmed {b.confirmedOn}
            </p>
          ))}
        </Group>
      ) : null}

      {o.guarantee ? (
        <Group title="Guarantee">
          <TickRow
            checked={c.guarantee}
            disabled={busy}
            label="I confirm these are our guarantee's real terms"
            onChange={(v) => onChange((x) => ({ ...x, guarantee: v }))}
          >
            <span className="block">I confirm these are our guarantee&apos;s real terms. (Legal review recommended.)</span>
            <span className="mt-1 block text-[12px] text-fg-muted">{o.guarantee.body}</span>
          </TickRow>
        </Group>
      ) : null}

      <Group title="Top video">
        <ProposalRow offer={o} checked={c.video} disabled={busy} onChange={(v) => onChange((x) => ({ ...x, video: v }))} />
      </Group>

      <div className="flex flex-wrap items-center gap-3 border-t border-bg-border pt-4">
        <button type="button" className="btn-secondary inline-flex min-h-11 items-center !px-4 text-sm" onClick={onSave} disabled={busy || !o.draft || !changed}>
          Save
        </button>
        <button
          type="button"
          className="btn-primary inline-flex min-h-11 items-center gap-2 !px-4 text-sm"
          onClick={onPublish}
          disabled={busy || !ready || !needsPublish(o, c)}
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
          {o.status === "draft" ? "Publish" : "Publish changes"}
        </button>
        {!changed && o.status === "live" && o.formEnabled ? <span className="text-[12px] text-fg-muted">Live, and nothing new to publish.</span> : null}
      </div>

      {words ? (
        <div role="status" className={`space-y-1 text-[13px] ${words.tone === "ok" ? "text-status-engaged" : words.tone === "warn" ? "text-status-warm" : "text-rose-400"}`}>
          {words.lines.map((l) => (
            <p key={l}>{l}</p>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function Group({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <div className="space-y-2">
      <div>
        <h3 className="text-[13px] font-semibold text-fg">{title}</h3>
        {hint ? <p className="text-[12px] text-fg-muted">{hint}</p> : null}
      </div>
      {children}
    </div>
  );
}

/** One tick, the whole row a 44px target (the builder's own size). */
function TickRow({
  checked,
  disabled,
  label,
  onChange,
  children,
}: {
  checked: boolean;
  disabled: boolean;
  label: string;
  onChange: (v: boolean) => void;
  children: ReactNode;
}) {
  return (
    <label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-lg px-2 py-2 text-[13px] text-fg hover:bg-bg-elev/60">
      <input
        type="checkbox"
        className="mt-0.5 h-5 w-5 shrink-0 accent-[rgb(var(--c-accent))]"
        checked={checked}
        disabled={disabled}
        aria-label={label}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="min-w-0">{children}</span>
    </label>
  );
}

function ProposalRow({ offer: o, checked, disabled, onChange }: { offer: ConfirmOffer; checked: boolean; disabled: boolean; onChange: (v: boolean) => void }) {
  const p = o.proposal;
  const keeps = o.draft?.hero.video ? "The page keeps the top video it has now." : "The page publishes without one.";
  if (p.state === "none") {
    return (
      <p className="text-[13px] text-fg-muted">
        No video proposed yet. {keeps}
      </p>
    );
  }
  if (p.state === "missing") {
    return (
      <p className="text-[13px] text-status-warm">
        The proposed video is not in this workspace&apos;s Library as an OASIS video with a video file, so there is nothing to attach. {keeps}
      </p>
    );
  }
  if (p.state === "unavailable") {
    return (
      <p className="text-[13px] text-status-warm">
        The proposed video{p.title ? `, "${p.title}",` : ""} is {libraryStatusWords(p.status)} in the Library, so it can&apos;t be attached from here. {keeps}
      </p>
    );
  }
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start gap-4">
        <ProposedPlayer title={p.title || "Proposed video"} aspect={p.ref.aspect} videoUrl={p.videoUrl} posterUrl={p.posterUrl} />
        <div className="min-w-0 flex-1 space-y-2 text-[13px]">
          <p className="font-semibold text-fg">{p.title || "Proposed video"}</p>
          <p className="text-fg-muted">
            Library status: {p.needsApproval ? "waiting for review" : p.status}.{p.ref.caption_media_id ? " Has captions." : " No captions."}
          </p>
          {p.onPage ? (
            <p className="flex items-center gap-2 text-status-engaged">
              <CheckCircle2 className="h-4 w-4" aria-hidden="true" /> This video is at the top of the page.
            </p>
          ) : (
            <>
              <TickRow
                checked={checked}
                disabled={disabled || !videoTickable(o)}
                label={p.needsApproval ? "Approve this video and confirm we own it" : "We own this video and may use it here"}
                onChange={onChange}
              >
                {p.needsApproval ? "Approve this video and confirm we own it." : "We own this video and may use it here."}
              </TickRow>
              <p className="text-[12px] text-fg-muted">
                {p.needsApproval ? "Saving approves it in the Library first, then puts it at the top of the page. " : "Saving puts it at the top of the page. "}
                {p.replaces ? "It replaces the top video the page has now. " : ""}
                Leave it unticked to publish without it.
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

const FRAME: Record<Aspect, string> = {
  "9:16": "aspect-[9/16] w-40 sm:w-48",
  "16:9": "aspect-video w-full max-w-md",
  "1:1": "aspect-square w-56",
  "4:5": "aspect-[4/5] w-48",
};

/** A poster and a Play button; the video loads only on the tap, as on the page itself. */
function ProposedPlayer({ title, aspect, videoUrl, posterUrl }: { title: string; aspect: Aspect; videoUrl: string | null; posterUrl: string | null }) {
  const [playing, setPlaying] = useState(false);
  const [failed, setFailed] = useState(false);
  const frame = `relative shrink-0 overflow-hidden rounded-lg border border-bg-border bg-bg-deep ${FRAME[aspect] ?? FRAME["16:9"]}`;
  if (!videoUrl) {
    return (
      <div className={`${frame} grid place-items-center p-3 text-center text-[12px] text-fg-muted`}>
        <span>
          <Film className="mx-auto mb-1 h-4 w-4" aria-hidden="true" />
          This video can&apos;t be played here. It can still be attached.
        </span>
      </div>
    );
  }
  if (playing && !failed) {
    return (
      <div className={frame}>
        <video src={videoUrl} controls autoPlay playsInline preload="auto" onError={() => setFailed(true)} className="absolute inset-0 h-full w-full bg-black object-contain" />
      </div>
    );
  }
  return (
    <button type="button" onClick={() => { setFailed(false); setPlaying(true); }} aria-label={`Play video: ${title}`} className={`${frame} group block text-left`}>
      {posterUrl ? (
        // eslint-disable-next-line @next/next/no-img-element -- a signed, private-bucket poster: next/image would proxy it
        <img src={posterUrl} alt="" className="absolute inset-0 h-full w-full object-cover opacity-90 group-hover:opacity-100" />
      ) : null}
      <span className="absolute inset-0 grid place-items-center" aria-hidden="true">
        <span className="grid h-12 w-12 place-items-center rounded-full bg-accent text-bg-deep">
          <Play className="ml-0.5 h-5 w-5" />
        </span>
      </span>
      {failed ? (
        <span className="absolute inset-x-2 bottom-2 rounded bg-bg-deep/90 px-2 py-1 text-[11px] text-fg-muted">
          It can&apos;t play right now. Reload the page to try again.
        </span>
      ) : null}
    </button>
  );
}
