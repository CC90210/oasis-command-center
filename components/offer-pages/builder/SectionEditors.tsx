"use client";

/**
 * The offer builder's section cards (design 2.2 step 3). Structured inputs, no
 * JSON. Each card shows its status (Hidden - empty / Needs your OK / Ready), and
 * moves up and down, hides and shows, and pins to the top menu.
 *
 * Claims are entered with their owner's word at the moment they go in: a result
 * is added only with the client's permission and a confirmation; a bonus value
 * only with "Confirm this value"; the guarantee shows only once its terms are
 * confirmed. The server records who confirmed each one and when.
 *
 * Placeholders are input hints, never saved, never drawn.
 */
import { useState } from "react";
import { ArrowDown, ArrowUp, Eye, EyeOff, Pin, PinOff, Plus, Trash2 } from "lucide-react";
import type {
  BodyKey,
  BodySection,
  BonusesSection,
  FaqSection,
  GuaranteeSection,
  Head,
  ObstaclesSection,
  OfferBrief,
  OfferPageDoc,
  ResultItem,
  ResultsSection,
  VideoRef,
  WhatYouGetSection,
  WorkSection,
} from "@/lib/offer-pages/types";
import { COPY_CAPS, ITEM_CAPS } from "@/lib/offer-pages/types";
import { NAV_LABELS, formatMoney } from "@/lib/offer-pages/visibility";
import { TextField, Tick, SmallButton, pendingConfirmation } from "./fields";
import { VideoPicker } from "./VideoPicker";

export type ChipState = "hidden" | "needs_ok" | "ready";

export function StatusChip({ state }: { state: ChipState }) {
  const map: Record<ChipState, [string, string]> = {
    hidden: ["Hidden - empty", "border-bg-border text-fg-dim"],
    needs_ok: ["Needs your OK", "border-status-warm/50 text-status-warm"],
    ready: ["Ready", "border-status-engaged/50 text-status-engaged"],
  };
  const [label, cls] = map[state];
  return <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${cls}`}>{label}</span>;
}

function move<T>(list: T[], i: number, by: -1 | 1): T[] {
  const j = i + by;
  if (j < 0 || j >= list.length) return list;
  const copy = [...list];
  [copy[i], copy[j]] = [copy[j], copy[i]];
  return copy;
}

function HeadFields({ head, onChange, titleHint }: { head: Head; onChange: (h: Head) => void; titleHint?: string }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <TextField label="Small label above the title" value={head.eyebrow} cap={COPY_CAPS.eyebrow} onChange={(v) => onChange({ ...head, eyebrow: v })} />
      <TextField label="Title" value={head.title} cap={COPY_CAPS.title} placeholder={titleHint} onChange={(v) => onChange({ ...head, title: v })} />
      <div className="sm:col-span-2">
        <TextField label="One or two lines under the title" value={head.lede} cap={COPY_CAPS.lede} multiline rows={2} onChange={(v) => onChange({ ...head, lede: v })} />
      </div>
    </div>
  );
}

function ItemFrame({
  index,
  count,
  onMove,
  onRemove,
  children,
}: {
  index: number;
  count: number;
  onMove: (by: -1 | 1) => void;
  onRemove: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-3 rounded-lg border border-bg-border bg-bg-deep/30 p-3">
      <div className="flex items-center justify-between">
        <span className="font-mono text-[11px] text-fg-dim">{String(index + 1).padStart(2, "0")}</span>
        <span className="flex items-center gap-2">
          <SmallButton onClick={() => onMove(-1)} disabled={index === 0} title="Move up">
            <ArrowUp className="h-3.5 w-3.5" />
          </SmallButton>
          <SmallButton onClick={() => onMove(1)} disabled={index === count - 1} title="Move down">
            <ArrowDown className="h-3.5 w-3.5" />
          </SmallButton>
          <SmallButton tone="danger" onClick={onRemove} title="Remove">
            <Trash2 className="h-3.5 w-3.5" />
          </SmallButton>
        </span>
      </div>
      {children}
    </div>
  );
}

// -- Hero ---------------------------------------------------------------------

export function HeroEditor({ hero, onChange }: { hero: OfferPageDoc["hero"]; onChange: (h: OfferPageDoc["hero"]) => void }) {
  return (
    <div className="grid gap-3">
      <TextField label="Small label above the headline" value={hero.eyebrow} cap={COPY_CAPS.eyebrow} onChange={(v) => onChange({ ...hero, eyebrow: v })} />
      <TextField label="Headline" value={hero.headline} cap={COPY_CAPS.headline} onChange={(v) => onChange({ ...hero, headline: v })} />
      <TextField label="Subheadline" value={hero.subheadline} cap={COPY_CAPS.subheadline} multiline rows={2} onChange={(v) => onChange({ ...hero, subheadline: v })} />
      <TextField label="Button label" value={hero.cta_label} cap={COPY_CAPS.cta_label} placeholder="Book a call" onChange={(v) => onChange({ ...hero, cta_label: v })} />
    </div>
  );
}

// -- Body sections -----------------------------------------------------------

export function SectionCard({
  section,
  index,
  count,
  pinned,
  chip,
  onChange,
  onMove,
  onRemove,
  onTogglePin,
  formId,
  libraryAvailable,
}: {
  section: BodySection;
  index: number;
  count: number;
  pinned: boolean;
  chip: ChipState;
  onChange: (s: BodySection) => void;
  onMove: (by: -1 | 1) => void;
  onRemove: () => void;
  onTogglePin: () => void;
  formId: string;
  libraryAvailable: boolean;
}) {
  const [open, setOpen] = useState(true);
  return (
    <div className="rounded-xl border border-bg-border bg-bg-elev/40">
      <div className="flex flex-wrap items-center gap-3 border-b border-bg-border px-4 py-3">
        <button type="button" onClick={() => setOpen((v) => !v)} className="text-sm font-bold text-fg">
          {NAV_LABELS[section.key]}
        </button>
        <StatusChip state={section.hidden ? "hidden" : chip} />
        <span className="ml-auto flex items-center gap-3">
          <SmallButton onClick={() => onMove(-1)} disabled={index === 0} title="Move up">
            <ArrowUp className="h-3.5 w-3.5" />
          </SmallButton>
          <SmallButton onClick={() => onMove(1)} disabled={index === count - 1} title="Move down">
            <ArrowDown className="h-3.5 w-3.5" />
          </SmallButton>
          <SmallButton onClick={() => onChange({ ...section, hidden: !section.hidden } as BodySection)} title={section.hidden ? "Show" : "Hide"}>
            {section.hidden ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
          </SmallButton>
          <SmallButton onClick={onTogglePin} title={pinned ? "Remove from the top menu" : "Pin to the top menu"}>
            {pinned ? <Pin className="h-3.5 w-3.5 text-accent" /> : <PinOff className="h-3.5 w-3.5" />}
          </SmallButton>
          <SmallButton tone="danger" onClick={onRemove} title="Remove the section">
            <Trash2 className="h-3.5 w-3.5" />
          </SmallButton>
        </span>
      </div>
      {open ? (
        <div className="space-y-4 p-4">
          {section.key !== "guarantee" ? (
            <HeadFields head={section} onChange={(h) => onChange({ ...section, ...h } as BodySection)} />
          ) : null}
          {section.key === "what_you_get" ? (
            <WhatYouGetItems s={section} onChange={onChange} formId={formId} libraryAvailable={libraryAvailable} />
          ) : section.key === "obstacles" ? (
            <ObstacleItems s={section} onChange={onChange} />
          ) : section.key === "work" ? (
            <WorkItems s={section} onChange={onChange} formId={formId} libraryAvailable={libraryAvailable} />
          ) : section.key === "results" ? (
            <ResultItems s={section} onChange={onChange} formId={formId} libraryAvailable={libraryAvailable} />
          ) : section.key === "bonuses" ? (
            <BonusItems s={section} onChange={onChange} />
          ) : section.key === "guarantee" ? (
            <GuaranteeFields s={section} onChange={onChange} />
          ) : (
            <FaqItems s={section} onChange={onChange} />
          )}
        </div>
      ) : null}
    </div>
  );
}

function WhatYouGetItems({
  s,
  onChange,
  formId,
  libraryAvailable,
}: {
  s: WhatYouGetSection;
  onChange: (s: BodySection) => void;
  formId: string;
  libraryAvailable: boolean;
}) {
  const set = (items: WhatYouGetSection["items"]) => onChange({ ...s, items });
  return (
    <div className="space-y-3">
      {s.items.map((it, i) => (
        <ItemFrame key={i} index={i} count={s.items.length} onMove={(by) => set(move(s.items, i, by))} onRemove={() => set(s.items.filter((_, j) => j !== i))}>
          <TextField label="What they get" value={it.title} cap={COPY_CAPS.title} onChange={(v) => set(s.items.map((x, j) => (j === i ? { ...x, title: v } : x)))} />
          <TextField label="In a sentence or two" value={it.body} cap={COPY_CAPS.body} multiline rows={2} onChange={(v) => set(s.items.map((x, j) => (j === i ? { ...x, body: v } : x)))} />
          <VideoPicker
            formId={formId}
            label="Optional demo video"
            value={it.video ?? null}
            libraryAvailable={libraryAvailable}
            onChange={(v) => set(s.items.map((x, j) => (j === i ? { ...x, video: v ?? undefined } : x)))}
          />
        </ItemFrame>
      ))}
      {s.items.length < ITEM_CAPS.what_you_get ? (
        <SmallButton tone="primary" onClick={() => set([...s.items, { title: "" }])}>
          <span className="inline-flex items-center gap-1">
            <Plus className="h-3 w-3" /> Add an item
          </span>
        </SmallButton>
      ) : null}
    </div>
  );
}

function ObstacleItems({ s, onChange }: { s: ObstaclesSection; onChange: (s: BodySection) => void }) {
  const set = (items: ObstaclesSection["items"]) => onChange({ ...s, items });
  return (
    <div className="space-y-3">
      {s.items.map((it, i) => (
        <ItemFrame key={i} index={i} count={s.items.length} onMove={(by) => set(move(s.items, i, by))} onRemove={() => set(s.items.filter((_, j) => j !== i))}>
          <TextField label="The problem" value={it.title} cap={COPY_CAPS.title} onChange={(v) => set(s.items.map((x, j) => (j === i ? { ...x, title: v } : x)))} />
          <TextField label="What it costs them" value={it.body} cap={COPY_CAPS.body} multiline rows={2} onChange={(v) => set(s.items.map((x, j) => (j === i ? { ...x, body: v } : x)))} />
        </ItemFrame>
      ))}
      {s.items.length < ITEM_CAPS.obstacles ? (
        <SmallButton tone="primary" onClick={() => set([...s.items, { title: "" }])}>
          <span className="inline-flex items-center gap-1">
            <Plus className="h-3 w-3" /> Add one
          </span>
        </SmallButton>
      ) : null}
    </div>
  );
}

function WorkItems({
  s,
  onChange,
  formId,
  libraryAvailable,
}: {
  s: WorkSection;
  onChange: (s: BodySection) => void;
  formId: string;
  libraryAvailable: boolean;
}) {
  const set = (items: WorkSection["items"]) => onChange({ ...s, items });
  return (
    <div className="space-y-3">
      {s.items.map((it, i) => (
        <ItemFrame key={i} index={i} count={s.items.length} onMove={(by) => set(move(s.items, i, by))} onRemove={() => set(s.items.filter((_, j) => j !== i))}>
          <VideoPicker
            formId={formId}
            label="The video"
            value={it.video}
            libraryAvailable={libraryAvailable}
            onChange={(v) => (v ? set(s.items.map((x, j) => (j === i ? { ...x, video: v } : x))) : set(s.items.filter((_, j) => j !== i)))}
          />
          <TextField label="Caption" value={it.title} cap={COPY_CAPS.title} onChange={(v) => set(s.items.map((x, j) => (j === i ? { ...x, title: v } : x)))} />
          <TextField label="A line about it" value={it.body} cap={COPY_CAPS.body} multiline rows={2} onChange={(v) => set(s.items.map((x, j) => (j === i ? { ...x, body: v } : x)))} />
        </ItemFrame>
      ))}
      {s.items.length < ITEM_CAPS.work ? (
        <VideoPicker
          formId={formId}
          label="Add a work video"
          value={null}
          libraryAvailable={libraryAvailable}
          onChange={(v) => {
            if (v) set([...s.items, { title: "", video: v }]);
          }}
        />
      ) : null}
    </div>
  );
}

function resultSummary(r: ResultItem): string {
  if (r.kind === "quote") return `"${r.quote}" - ${r.who}`;
  if (r.kind === "metric") return `${r.value} ${r.label} (source: ${r.source})`;
  if (r.kind === "video") return `Video${r.label ? `: ${r.label}` : ""}`;
  return `Screenshot: ${r.alt}`;
}

function ResultItems({
  s,
  onChange,
  formId,
  libraryAvailable,
}: {
  s: ResultsSection;
  onChange: (s: BodySection) => void;
  formId: string;
  libraryAvailable: boolean;
}) {
  const set = (items: ResultItem[]) => onChange({ ...s, items });
  const [kind, setKind] = useState<"quote" | "metric" | "video">("quote");
  const [quote, setQuote] = useState("");
  const [who, setWho] = useState("");
  const [role, setRole] = useState("");
  const [value, setValue] = useState("");
  const [label, setLabel] = useState("");
  const [source, setSource] = useState("");
  const [video, setVideo] = useState<VideoRef | null>(null);
  const [permission, setPermission] = useState(false);
  const [confirmed, setConfirmed] = useState(false);

  const complete =
    permission &&
    confirmed &&
    (kind === "quote" ? quote.trim() && who.trim() : kind === "metric" ? value.trim() && label.trim() && source.trim() : !!video);

  function add() {
    if (!complete) return;
    const evidence = { permission: true as const, confirmed: pendingConfirmation() };
    const item: ResultItem =
      kind === "quote"
        ? { kind, quote: quote.trim(), who: who.trim(), ...(role.trim() ? { role: role.trim() } : {}), evidence }
        : kind === "metric"
          ? { kind, value: value.trim(), label: label.trim(), source: source.trim(), evidence }
          : { kind: "video", video: video!, ...(label.trim() ? { label: label.trim() } : {}), ...(who.trim() ? { who: who.trim() } : {}), evidence };
    set([...s.items, item]);
    setQuote("");
    setWho("");
    setRole("");
    setValue("");
    setLabel("");
    setSource("");
    setVideo(null);
    setPermission(false);
    setConfirmed(false);
  }

  return (
    <div className="space-y-3">
      {s.items.map((it, i) => (
        <ItemFrame key={i} index={i} count={s.items.length} onMove={(by) => set(move(s.items, i, by))} onRemove={() => set(s.items.filter((_, j) => j !== i))}>
          <p className="text-[13px] text-fg">{resultSummary(it)}</p>
          <p className="text-[11px] text-fg-dim">Shown with the client&apos;s permission, confirmed {it.evidence.confirmed.at.slice(0, 10)}.</p>
        </ItemFrame>
      ))}
      {s.items.length < ITEM_CAPS.results ? (
        <div className="space-y-3 rounded-lg border border-dashed border-bg-border p-3">
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-[13px] font-semibold text-fg">Add a result</span>
            {(["quote", "metric", "video"] as const).map((k) => (
              <button
                type="button"
                key={k}
                onClick={() => setKind(k)}
                className={`rounded-full border px-2.5 py-0.5 text-[11px] ${kind === k ? "border-accent text-accent" : "border-bg-border text-fg-muted"}`}
              >
                {k === "quote" ? "A client's words" : k === "metric" ? "A number, with its source" : "A video"}
              </button>
            ))}
          </div>
          {kind === "quote" ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <TextField label="What they said" value={quote} cap={COPY_CAPS.quote} multiline rows={2} onChange={setQuote} />
              </div>
              <TextField label="Who" value={who} cap={COPY_CAPS.who} onChange={setWho} />
              <TextField label="Their role or company" value={role} cap={COPY_CAPS.role} onChange={setRole} />
            </div>
          ) : kind === "metric" ? (
            <div className="grid gap-3 sm:grid-cols-3">
              <TextField label="The number" value={value} cap={COPY_CAPS.metric_value} onChange={setValue} />
              <TextField label="What it measures" value={label} cap={COPY_CAPS.label} onChange={setLabel} />
              <TextField label="Where it comes from" value={source} cap={COPY_CAPS.source} onChange={setSource} />
            </div>
          ) : (
            <div className="space-y-3">
              <VideoPicker formId={formId} label="The video" value={video} libraryAvailable={libraryAvailable} onChange={setVideo} />
              <div className="grid gap-3 sm:grid-cols-2">
                <TextField label="Label" value={label} cap={COPY_CAPS.label} onChange={setLabel} />
                <TextField label="Who" value={who} cap={COPY_CAPS.who} onChange={setWho} />
              </div>
            </div>
          )}
          <Tick checked={permission} onChange={setPermission}>
            I have this client&apos;s permission to show this.
          </Tick>
          <Tick checked={confirmed} onChange={setConfirmed}>
            This is true, and we can back it with evidence.
          </Tick>
          <button type="button" className="btn-primary !px-3 !py-1.5 text-xs" disabled={!complete} onClick={add}>
            Add the result
          </button>
          <p className="text-[11px] text-fg-dim">Screenshots arrive with image uploads in the next update.</p>
        </div>
      ) : null}
    </div>
  );
}

function BonusItems({ s, onChange }: { s: BonusesSection; onChange: (s: BodySection) => void }) {
  const set = (items: BonusesSection["items"]) => onChange({ ...s, items });
  return (
    <div className="space-y-3">
      {s.items.map((it, i) => (
        <ItemFrame key={i} index={i} count={s.items.length} onMove={(by) => set(move(s.items, i, by))} onRemove={() => set(s.items.filter((_, j) => j !== i))}>
          <TextField label="The bonus" value={it.title} cap={COPY_CAPS.title} onChange={(v) => set(s.items.map((x, j) => (j === i ? { ...x, title: v } : x)))} />
          <TextField label="What it is" value={it.body} cap={COPY_CAPS.body} multiline rows={2} onChange={(v) => set(s.items.map((x, j) => (j === i ? { ...x, body: v } : x)))} />
          <BonusValue
            value={it.value ?? null}
            onChange={(value) => set(s.items.map((x, j) => (j === i ? { ...x, value } : x)))}
          />
        </ItemFrame>
      ))}
      {s.items.length < ITEM_CAPS.bonuses ? (
        <SmallButton tone="primary" onClick={() => set([...s.items, { title: "" }])}>
          <span className="inline-flex items-center gap-1">
            <Plus className="h-3 w-3" /> Add a bonus
          </span>
        </SmallButton>
      ) : null}
      <TextField
        label="Footnote under the values"
        value={s.value_note}
        cap={COPY_CAPS.value_note}
        hint="Shown only next to a confirmed value."
        onChange={(v) => onChange({ ...s, value_note: v })}
      />
    </div>
  );
}

function BonusValue({
  value,
  onChange,
}: {
  value: BonusesSection["items"][number]["value"];
  onChange: (v: BonusesSection["items"][number]["value"]) => void;
}) {
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState<"CAD" | "USD">("CAD");
  const [ok, setOk] = useState(false);
  if (value) {
    return (
      <div className="flex items-center gap-3 text-[13px] text-fg">
        Value {formatMoney(value)} (confirmed)
        <SmallButton tone="danger" onClick={() => onChange(null)}>
          Remove the value
        </SmallButton>
      </div>
    );
  }
  const cents = Math.round(Number(amount.replace(/[^0-9.]/g, "")) * 100);
  const valid = amount.trim() !== "" && Number.isFinite(cents) && cents >= 0;
  return (
    <div className="flex flex-wrap items-end gap-3">
      <label className="block space-y-1">
        <span className="label">Value (optional)</span>
        <input className="input w-32" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
      </label>
      <select className="select" value={currency} onChange={(e) => setCurrency(e.target.value as "CAD" | "USD")} aria-label="Currency">
        <option value="CAD">CAD</option>
        <option value="USD">USD</option>
      </select>
      <Tick checked={ok} onChange={setOk}>
        Confirm this value
      </Tick>
      <button
        type="button"
        className="btn-secondary !px-3 !py-1.5 text-xs"
        disabled={!valid || !ok}
        onClick={() => {
          onChange({ cents, currency, confirmed: pendingConfirmation() });
          setAmount("");
          setOk(false);
        }}
      >
        Set the value
      </button>
    </div>
  );
}

function GuaranteeFields({ s, onChange }: { s: GuaranteeSection; onChange: (s: BodySection) => void }) {
  return (
    <div className="space-y-3">
      <HeadFields head={s} onChange={(h) => onChange({ ...s, ...h })} />
      <TextField
        label="The guarantee, in plain words"
        value={s.body}
        cap={COPY_CAPS.guarantee_body}
        multiline
        rows={3}
        onChange={(v) => onChange({ ...s, body: v, confirmed: undefined })}
        hint="Editing it clears the confirmation."
      />
      <label className="block space-y-1">
        <span className="label">Link to the full terms (https)</span>
        <input className="input w-full" value={s.terms_url ?? ""} onChange={(e) => onChange({ ...s, terms_url: e.target.value || undefined })} />
      </label>
      <Tick
        checked={!!s.confirmed}
        onChange={(v) => onChange({ ...s, confirmed: v ? pendingConfirmation() : undefined })}
      >
        I confirm these are our guarantee&apos;s real terms. (Legal review recommended.)
      </Tick>
    </div>
  );
}

function FaqItems({ s, onChange }: { s: FaqSection; onChange: (s: BodySection) => void }) {
  const set = (items: FaqSection["items"]) => onChange({ ...s, items });
  return (
    <div className="space-y-3">
      {s.items.map((it, i) => (
        <ItemFrame key={i} index={i} count={s.items.length} onMove={(by) => set(move(s.items, i, by))} onRemove={() => set(s.items.filter((_, j) => j !== i))}>
          <TextField label="Question" value={it.q} cap={COPY_CAPS.faq_q} onChange={(v) => set(s.items.map((x, j) => (j === i ? { ...x, q: v } : x)))} />
          <TextField label="Answer" value={it.a} cap={COPY_CAPS.faq_a} multiline rows={3} onChange={(v) => set(s.items.map((x, j) => (j === i ? { ...x, a: v } : x)))} />
        </ItemFrame>
      ))}
      {s.items.length < ITEM_CAPS.faq ? (
        <SmallButton tone="primary" onClick={() => set([...s.items, { q: "", a: "" }])}>
          <span className="inline-flex items-center gap-1">
            <Plus className="h-3 w-3" /> Add a question
          </span>
        </SmallButton>
      ) : null}
    </div>
  );
}

/** A new, empty section of this kind. */
export function newSection(key: BodyKey): BodySection {
  if (key === "guarantee") return { key: "guarantee" };
  return { key, items: [] } as BodySection;
}

// -- Book and brief ----------------------------------------------------------

export function BookEditor({ book, onChange, bookingLinkSet }: { book: OfferPageDoc["book"]; onChange: (b: OfferPageDoc["book"]) => void; bookingLinkSet: boolean }) {
  return (
    <div className="space-y-4">
      <HeadFields head={book} onChange={(h) => onChange({ ...book, ...h, hidden: undefined })} titleHint="Book a walkthrough" />
      <label className="block space-y-1">
        <span className="label">After someone leaves their details</span>
        <select className="select w-full" value={book.mode} onChange={(e) => onChange({ ...book, mode: e.target.value as OfferPageDoc["book"]["mode"] })}>
          <option value="form_then_link">Offer a time to book, then the rest of the questions</option>
          <option value="form">Just the questions</option>
        </select>
      </label>
      {book.mode === "form_then_link" ? (
        <p className="text-[12px] text-fg-muted">
          {bookingLinkSet
            ? "They see a Pick a time button for your booking page. Booking right on the page arrives in a later update."
            : "No booking link is set for this workspace, so they're asked for two times that suit them, or told you'll be in touch."}
        </p>
      ) : null}
    </div>
  );
}

export function BriefEditor({
  brief,
  onChange,
  canRequest,
}: {
  brief: OfferBrief | undefined;
  onChange: (b: OfferBrief | undefined) => void;
  canRequest: boolean;
}) {
  const b = brief ?? {};
  const set = (k: keyof OfferBrief, v: string) => onChange({ ...b, [k]: v });
  return (
    <div className="space-y-3">
      <p className="text-[12px] text-fg-muted">
        The facts whoever writes your copy needs. Never shown on the page, and never published.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField label="Who it's for" value={b.audience} cap={COPY_CAPS.brief} multiline rows={2} onChange={(v) => set("audience", v)} />
        <TextField label="The promise" value={b.promise} cap={COPY_CAPS.brief} multiline rows={2} onChange={(v) => set("promise", v)} />
        <TextField label="What's included" value={b.included} cap={COPY_CAPS.brief} multiline rows={2} onChange={(v) => set("included", v)} />
        <TextField label="What proof exists" value={b.proof_available} cap={COPY_CAPS.brief} multiline rows={2} onChange={(v) => set("proof_available", v)} />
        <TextField label="Price, if shown" value={b.price} cap={COPY_CAPS.brief} onChange={(v) => set("price", v)} />
        <TextField label="The real bonuses" value={b.bonuses} cap={COPY_CAPS.brief} multiline rows={2} onChange={(v) => set("bonuses", v)} />
        <div className="sm:col-span-2">
          <TextField label="Guarantee terms" value={b.guarantee} cap={COPY_CAPS.brief} multiline rows={2} onChange={(v) => set("guarantee", v)} />
        </div>
      </div>
      {canRequest ? (
        <div className="flex items-center gap-3">
          <button
            type="button"
            className="btn-secondary !px-3 !py-1.5 text-xs"
            onClick={() => onChange({ ...b, requested_at: new Date().toISOString() })}
          >
            Ask for copy
          </button>
          {b.requested_at ? <span className="text-[11px] text-fg-dim">Asked {b.requested_at.slice(0, 10)}.</span> : null}
        </div>
      ) : null}
    </div>
  );
}
