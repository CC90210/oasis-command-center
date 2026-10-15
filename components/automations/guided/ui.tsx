/**
 * components/automations/guided/ui.tsx - the small controls the guided builder is made of.
 *
 * Plain markup and the repo's semantic tokens only, so dark and light both work: no new dependency, no
 * icon set (one inline check mark), no animation beyond a 120 ms colour change that reduced-motion
 * turns off. Every control carries its own label, its description and its error by id, so a person on a
 * keyboard or a screen reader gets the same sentence a sighted person reads.
 */
import type { ReactNode } from "react";
import type { ConnectionState, GuidedStatus, RepairLink } from "@/lib/automations/guided/api-types";
import { choiceStyle, counterText, statusLabel } from "@/lib/automations/guided/view";
import type { ChoiceField } from "@/lib/automations/guided/types";

export const TAP = "min-h-11";
const FOCUS = "peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent";
const FOCUS_WITHIN = "has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent";

export function Check({ className = "h-3.5 w-3.5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M3 8.5l3.2 3.2L13 4.8" />
    </svg>
  );
}

// ── messages ─────────────────────────────────────────────────────────────

const NOTICE_TONES = {
  error: "border-status-hot/40 bg-status-hot/10 text-fg",
  warn: "border-status-warm/40 bg-status-warm/10 text-fg",
  ok: "border-status-engaged/40 bg-status-engaged/10 text-fg",
  info: "border-hairline bg-bg-elev text-fg-muted",
} as const;

/** A sentence the person must see. Errors are announced at once; the rest politely. */
export function Notice({ tone, children, live = true, id }: { tone: keyof typeof NOTICE_TONES; children: ReactNode; live?: boolean; id?: string }) {
  const role = !live ? undefined : tone === "error" ? "alert" : "status";
  return (
    <div id={id} role={role} className={`rounded-lg border px-3 py-2.5 text-sm leading-relaxed ${NOTICE_TONES[tone]}`}>
      {children}
    </div>
  );
}

/** The error under one field, tied to it by id. */
export function FieldError({ id, message }: { id: string; message: string | null }) {
  if (!message) return null;
  return (
    <p id={id} role="alert" className="text-xs leading-5 text-status-hot">
      {message}
    </p>
  );
}

/** A Connections-hub link: opens in a new tab so the wizard keeps what has been filled in. */
export function RepairAnchor({ link }: { link: RepairLink }) {
  return (
    <a href={link.href} target="_blank" rel="noopener noreferrer" className={`inline-flex ${TAP} items-center text-sm font-medium text-accent underline underline-offset-2 hover:no-underline`}>
      {link.label}
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}

// ── status ───────────────────────────────────────────────────────────────

const STATUS_TONE: Record<GuidedStatus, { box: string; dot: string }> = {
  paused: { box: "border-hairline bg-bg-elev text-fg-muted", dot: "border border-fg-dim" },
  on: { box: "border-status-engaged/40 bg-status-engaged/10 text-status-engaged", dot: "bg-status-engaged" },
  needs_attention: { box: "border-status-warm/40 bg-status-warm/10 text-status-warm", dot: "bg-status-warm" },
};

/** Paused, On or Needs attention: always the word, never only the colour. */
export function StatusPill({ status }: { status: GuidedStatus }) {
  const tone = STATUS_TONE[status] ?? STATUS_TONE.paused;
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs font-medium ${tone.box}`}>
      <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${tone.dot}`} />
      {statusLabel(status)}
    </span>
  );
}

const CONNECTION_TONE: Record<ConnectionState, string> = {
  connected: "text-status-engaged",
  attention: "text-status-warm",
  not_connected: "text-status-hot",
  unknown: "text-fg-muted",
};

export function ConnectionMark({ state, label }: { state: ConnectionState; label: string }) {
  return (
    <span className={`inline-flex items-center gap-1.5 text-sm font-medium ${CONNECTION_TONE[state] ?? CONNECTION_TONE.unknown}`}>
      {state === "connected" ? (
        <Check />
      ) : (
        <span aria-hidden="true" className="inline-flex h-3.5 w-3.5 items-center justify-center rounded-sm border border-current text-[10px] font-bold leading-none">
          {state === "unknown" ? "?" : state === "attention" ? "!" : ""}
        </span>
      )}
      {label}
    </span>
  );
}

// ── cards and rows ───────────────────────────────────────────────────────

/**
 * One option of a pick-one list, drawn as a card: a real radio button, its title, its words. The radio
 * is visible, so the choice is never only a colour, and arrow keys move through a group because the
 * radios share a name.
 */
export function OptionCard({
  name,
  value,
  checked,
  disabled = false,
  onSelect,
  title,
  children,
  dashed = false,
}: {
  name: string;
  value: string;
  checked: boolean;
  disabled?: boolean;
  onSelect: () => void;
  title: string;
  children?: ReactNode;
  dashed?: boolean;
}) {
  const base = `gb-${name}-${value}`;
  const state = disabled
    ? "cursor-not-allowed border-hairline bg-bg-panel opacity-70"
    : "cursor-pointer border-hairline bg-bg-panel hover:border-bg-border-strong has-[:checked]:border-accent has-[:checked]:bg-accent-soft";
  return (
    <label className={`flex ${TAP} items-start gap-3 rounded-xl border p-4 motion-safe:transition-colors ${dashed ? "border-dashed" : ""} ${state} ${FOCUS_WITHIN}`}>
      <input
        type="radio"
        name={name}
        value={value}
        checked={checked}
        disabled={disabled}
        onChange={onSelect}
        aria-labelledby={`${base}-t`}
        aria-describedby={`${base}-d`}
        className="mt-1 h-4 w-4 shrink-0 accent-accent"
      />
      <span className="min-w-0 flex-1">
        <span id={`${base}-t`} className="block text-sm font-semibold leading-5 text-fg">
          {title}
        </span>
        <span id={`${base}-d`} className="mt-1 block space-y-1 text-sm leading-relaxed text-fg-muted">
          {children}
        </span>
      </span>
    </label>
  );
}

/** A smaller pick-one row, for the options of a setting. */
function OptionRow({ name, value, label, checked, onSelect, disabled = false }: { name: string; value: string; label: string; checked: boolean; onSelect: () => void; disabled?: boolean }) {
  return (
    <label
      className={`flex ${TAP} items-center gap-3 rounded-lg border px-3 py-2 text-sm motion-safe:transition-colors ${FOCUS_WITHIN} ${
        disabled
          ? "cursor-not-allowed border-hairline text-fg-dim"
          : "cursor-pointer border-hairline text-fg hover:border-bg-border-strong has-[:checked]:border-accent has-[:checked]:bg-accent-soft"
      }`}
    >
      <input type="radio" name={name} value={value} checked={checked} disabled={disabled} onChange={onSelect} className="h-4 w-4 shrink-0 accent-accent" />
      <span>{label}</span>
    </label>
  );
}

// ── field shell ──────────────────────────────────────────────────────────

/** Label, help, control and error as one unit. The control gets `describedBy` to put on itself. */
export function Field({
  id,
  label,
  help,
  error,
  children,
}: {
  id: string;
  label: string;
  help?: string;
  error: string | null;
  children: (describedBy: string | undefined) => ReactNode;
}) {
  const helpId = help ? `${id}-help` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [helpId, errorId].filter(Boolean).join(" ") || undefined;
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-medium text-fg">
        {label}
      </label>
      {help && (
        <p id={helpId} className="text-xs leading-5 text-fg-dim">
          {help}
        </p>
      )}
      {children(describedBy)}
      <FieldError id={`${id}-error`} message={error} />
    </div>
  );
}

/** Same shell for a group of radios or checkboxes: a fieldset with a legend instead of a label. */
export function GroupField({
  id,
  legend,
  help,
  error,
  hideLegend = false,
  children,
}: {
  id: string;
  legend: string;
  help?: string;
  error: string | null;
  /** The group already has a visible heading; the legend then only names it for a screen reader. */
  hideLegend?: boolean;
  children: (describedBy: string | undefined) => ReactNode;
}) {
  const helpId = help ? `${id}-help` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [helpId, errorId].filter(Boolean).join(" ") || undefined;
  return (
    <fieldset className="min-w-0 space-y-1.5" aria-describedby={describedBy}>
      <legend className={hideLegend ? "sr-only" : "text-sm font-medium text-fg"}>{legend}</legend>
      {help && (
        <p id={helpId} className="text-xs leading-5 text-fg-dim">
          {help}
        </p>
      )}
      {children(describedBy)}
      <FieldError id={`${id}-error`} message={error} />
    </fieldset>
  );
}

// ── controls ─────────────────────────────────────────────────────────────

type Option = { value: string; label: string; disabled?: boolean };

/** A few short options side by side: the picked one is filled and carries a check. */
export function Segmented({ name, options, value, onChange }: { name: string; options: readonly Option[]; value: string; onChange: (value: string) => void }) {
  return (
    <div className="inline-flex max-w-full flex-wrap gap-1 rounded-lg border border-hairline bg-bg-deep p-1">
      {options.map((o) => (
        <label key={o.value} className={o.disabled ? "cursor-not-allowed" : "cursor-pointer"}>
          <input type="radio" name={name} value={o.value} checked={value === o.value} disabled={o.disabled} onChange={() => onChange(o.value)} className="peer sr-only" />
          <span
            className={`flex ${TAP} items-center gap-1.5 rounded-md px-4 text-sm motion-safe:transition-colors ${FOCUS} ${
              o.disabled
                ? "text-fg-dim"
                : "text-fg-muted hover:bg-active peer-checked:bg-fg peer-checked:font-medium peer-checked:text-bg peer-checked:hover:bg-fg"
            } [&_svg]:hidden peer-checked:[&_svg]:block`}
          >
            <Check />
            {o.label}
          </span>
        </label>
      ))}
    </div>
  );
}

/** Wrapping chips (schedules, days): the picked one is outlined and checked. */
export function ChipGroup({ name, type, options, isChecked, onToggle }: { name: string; type: "radio" | "checkbox"; options: readonly { value: string; label: ReactNode; srLabel?: string }[]; isChecked: (value: string) => boolean; onToggle: (value: string) => void }) {
  return (
    <div className="flex flex-wrap gap-2">
      {options.map((o) => (
        <label key={o.value} className="cursor-pointer">
          <input type={type} name={name} value={o.value} checked={isChecked(o.value)} onChange={() => onToggle(o.value)} className="peer sr-only" />
          <span
            className={`flex ${TAP} items-center gap-1.5 rounded-md border border-hairline bg-bg-deep px-3 text-sm text-fg-muted hover:border-bg-border-strong motion-safe:transition-colors peer-checked:border-accent peer-checked:bg-accent-soft peer-checked:text-fg ${FOCUS} [&_svg]:hidden peer-checked:[&_svg]:block`}
          >
            <Check />
            {o.srLabel ? (
              <>
                <span aria-hidden="true">{o.label}</span>
                <span className="sr-only">{o.srLabel}</span>
              </>
            ) : (
              o.label
            )}
          </span>
        </label>
      ))}
    </div>
  );
}

/** One of a template's pick-one settings, drawn as the shape that fits its options. */
export function ChoiceControl({ field, id, value, onChange, describedBy }: { field: ChoiceField; id: string; value: string; onChange: (value: string) => void; describedBy?: string }) {
  const style = choiceStyle(field);
  if (style === "segmented") return <Segmented name={id} options={field.options} value={value} onChange={onChange} />;
  if (style === "list") {
    return (
      <div className="space-y-2">
        {field.options.map((o) => (
          <OptionRow key={o.value} name={id} value={o.value} label={o.label} checked={value === o.value} onSelect={() => onChange(o.value)} />
        ))}
      </div>
    );
  }
  return (
    <select id={id} className={`select ${TAP}`} value={value} aria-describedby={describedBy} onChange={(e) => onChange(e.target.value)}>
      {field.options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

/** A whole number with a stepper. The person may also type; the validator names a number that is out of range. */
export function NumberControl({
  id,
  label,
  value,
  min,
  max,
  unit,
  onChange,
  onBlur,
  describedBy,
  invalid,
}: {
  id: string;
  label: string;
  value: string | number;
  min: number;
  max: number;
  unit?: string;
  onChange: (value: string | number) => void;
  onBlur: () => void;
  describedBy?: string;
  invalid: boolean;
}) {
  const n = typeof value === "number" ? value : Number(value);
  const step = (delta: number) => onChange(Math.min(max, Math.max(min, (Number.isFinite(n) ? n : min) + delta)));
  const stepper = `${TAP} min-w-11 px-3 text-lg leading-none text-fg hover:bg-active disabled:cursor-not-allowed disabled:text-fg-dim disabled:hover:bg-transparent motion-safe:transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent`;
  return (
    <div className="flex flex-wrap items-center gap-3">
      <div className={`inline-flex items-stretch overflow-hidden rounded-lg border bg-bg-deep ${invalid ? "border-status-hot" : "border-hairline"}`}>
        <button type="button" className={stepper} aria-label={`Decrease: ${label}`} disabled={Number.isFinite(n) && n <= min} onClick={() => step(-1)}>
          <span aria-hidden="true">-</span>
        </button>
        <input
          id={id}
          type="number"
          inputMode="numeric"
          min={min}
          max={max}
          step={1}
          value={String(value)}
          aria-describedby={describedBy}
          aria-invalid={invalid || undefined}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onBlur}
          className={`${TAP} w-16 border-x border-hairline bg-transparent px-1 text-center text-sm tabular-nums text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent`}
        />
        <button type="button" className={stepper} aria-label={`Increase: ${label}`} disabled={Number.isFinite(n) && n >= max} onClick={() => step(1)}>
          <span aria-hidden="true">+</span>
        </button>
      </div>
      {unit && <span className="text-sm text-fg-muted">{unit}</span>}
      <span className="text-xs text-fg-dim">
        {min} to {max}
      </span>
    </div>
  );
}

/** One short line with a live counter against its limit. Typing past the limit is allowed and told, never silently cut. */
export function TextControl({
  id,
  value,
  maxLength,
  placeholder,
  onChange,
  onBlur,
  describedBy,
  invalid,
}: {
  id: string;
  value: string;
  maxLength: number;
  placeholder?: string;
  onChange: (value: string) => void;
  onBlur: () => void;
  describedBy?: string;
  invalid: boolean;
}) {
  const over = value.length > maxLength;
  const counterId = `${id}-count`;
  return (
    <div className="space-y-1">
      <input
        id={id}
        type="text"
        autoComplete="off"
        value={value}
        placeholder={placeholder}
        aria-describedby={[describedBy, counterId].filter(Boolean).join(" ")}
        aria-invalid={invalid || over || undefined}
        onChange={(e) => onChange(e.target.value.replace(/[\r\n]+/g, " "))}
        onBlur={onBlur}
        className={`input ${TAP} ${invalid || over ? "border-status-hot" : ""}`}
      />
      <p id={counterId} className={`text-right text-xs tabular-nums ${over ? "font-medium text-status-hot" : "text-fg-dim"}`}>
        {counterText(value.length, maxLength)}
      </p>
    </div>
  );
}

/** A tick box with a title and a line under it (the custom brief's reads). */
export function CheckRow({ id, name, checked, onToggle, title, summary }: { id: string; name: string; checked: boolean; onToggle: (on: boolean) => void; title: string; summary: string }) {
  return (
    <label className={`flex ${TAP} items-start gap-3 rounded-lg border px-3 py-2.5 motion-safe:transition-colors ${FOCUS_WITHIN} cursor-pointer border-hairline hover:border-bg-border-strong has-[:checked]:border-accent has-[:checked]:bg-accent-soft`}>
      <input id={id} type="checkbox" name={name} checked={checked} onChange={(e) => onToggle(e.target.checked)} aria-labelledby={`${id}-t`} aria-describedby={`${id}-d`} className="mt-1 h-4 w-4 shrink-0 accent-accent" />
      <span className="min-w-0">
        <span id={`${id}-t`} className="block text-sm font-medium text-fg">
          {title}
        </span>
        <span id={`${id}-d`} className="block text-xs leading-5 text-fg-muted">
          {summary}
        </span>
      </span>
    </label>
  );
}
