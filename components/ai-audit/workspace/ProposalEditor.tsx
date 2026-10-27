"use client";

/**
 * Section 8, the priced proposal. Lines come from the confirmed catalogue (the
 * server copies the confirmed price, whatever this page sends), or carry a
 * price CC types for custom work, or wait as "needs your price". Totals are
 * computed, never typed. The delivery email lives here too, because CC's final
 * approval binds to it with the proposal.
 */
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  AUDIT_LINK_PLACEHOLDER,
  emptyProposal,
  itemPriceIn,
  proposalBlockers,
  rateText,
  proposalTotals,
  withConfirmedPrice,
  type FxRate,
  type ProposalContent,
  type ProposalLine,
  type TaxRule,
} from "@/lib/ai-audit/proposal";
import { formatMoney, type CatalogueItem } from "@/lib/ai-audit/catalogue";
import { CATALOGUE_CATEGORIES, CATALOGUE_UNITS, type CatalogueCategory, type CatalogueUnit, type Currency } from "@/lib/ai-audit/rules";
import { describeError, postAction } from "./api";
import { NumberInput } from "./inputs";

type Props = {
  engagementId: string;
  initial: ProposalContent | null;
  rowVersion: number;
  editable: boolean;
  catalogue: CatalogueItem[];
  settings: { tax: TaxRule | null; default_currency: Currency; deposit_bps: number | null; fx_usd_cad: FxRate | null };
  defaults: { to: string; businessName: string; contactName: string };
  /** Only the workspace owner types a custom price (the server enforces it too). */
  isOwner: boolean;
};

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function lineId(lines: ProposalLine[]): string {
  let n = lines.length + 1;
  while (lines.some((l) => l.line_id === `l${n}`)) n += 1;
  return `l${n}`;
}

/** The same tax rule, whatever order its fields were written in. */
function sameTax(a: TaxRule | null, b: TaxRule | null): boolean {
  if (!a || !b) return a === b;
  if (a.mode !== b.mode) return false;
  return a.mode === "not_registered" || (b.mode === "registered" && a.rate_bps === b.rate_bps && a.label === b.label && (a.number ?? "") === (b.number ?? ""));
}

function inDays(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

export function ProposalEditor({ engagementId, initial, rowVersion, editable, catalogue, settings, defaults, isOwner }: Props) {
  const router = useRouter();
  const [p, setP] = useState<ProposalContent>(
    () =>
      initial ??
      emptyProposal({
        currency: settings.default_currency,
        tax: settings.tax,
        to: defaults.to,
        businessName: defaults.businessName || "your business",
        contactName: defaults.contactName,
        validUntil: inDays(30),
      }),
  );
  const [rv, setRv] = useState(rowVersion);
  // Stays mounted across tabs: follow the engagement's row version (this draft is kept).
  useEffect(() => setRv(rowVersion), [rowVersion]);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [pick, setPick] = useState("");
  const shown = useMemo(() => ({ ...p, tax: settings.tax }), [p, settings.tax]);
  const totals = proposalTotals(shown);
  const blockers = proposalBlockers(shown, new Date().toISOString().slice(0, 10));
  const fx = settings.fx_usd_cad;
  /** A confirmed item's price in this proposal's currency: its own, or converted at CC's rate; null when it cannot be. */
  const priceOf = (item: CatalogueItem, currency: Currency = p.currency) => itemPriceIn(item, currency, fx);
  const usable = catalogue.filter((c) => c.status === "confirmed" && priceOf(c) !== null);
  // The rate the lines were priced at (what the client sees), not the one in settings: they differ until a save.
  const appliedFx = p.lines.flatMap((l) => (l.kind === "catalogue" && l.fx ? [l.fx] : []))[0] ?? null;
  const rateWords = appliedFx ? `1 USD = ${rateText(appliedFx.rate_ppm)} CAD (${appliedFx.as_of})` : null;
  // What a save would change in the stored draft (lib/ai-audit/versions.ts normalizeProposal): the current tax
  // rule, and any catalogue line that would price differently now: its item no longer confirmed, a new price, or a
  // new exchange rate (Codex review of #752). Submit refuses until it is saved again, so Save is offered.
  const taxChanged = !!initial && !sameTax(initial.tax, settings.tax);
  const priceChanged =
    !!initial &&
    initial.lines.some((l) => {
      if (l.kind !== "catalogue") return false;
      const item = catalogue.find((c) => c.id === l.item_id && c.status === "confirmed");
      const now = item ? itemPriceIn(item, initial.currency, fx) : null;
      return !now || now.unit_price_cents !== l.unit_price_cents || (now.fx?.rate_ppm ?? null) !== (l.fx?.rate_ppm ?? null) || (now.fx?.as_of ?? null) !== (l.fx?.as_of ?? null);
    });
  const staleWords =
    taxChanged && priceChanged
      ? "The tax rule changed since this was saved, and so did a price or the exchange rate: save it to apply them."
      : taxChanged
        ? "The tax rule changed since this was saved: save it to apply."
        : priceChanged
          ? "A price or the exchange rate changed since this was saved: save it to apply."
          : null;
  const disabled = !editable || busy;
  const money = (c: number) => formatMoney(c, p.currency);

  function update(fn: (d: ProposalContent) => void) {
    setP((prev) => {
      const next = clone(prev);
      fn(next);
      return next;
    });
    setDirty(true);
  }

  /** A line waiting for a price takes its suggested item's confirmed price, in place (lib/ai-audit/proposal.ts). */
  function takeConfirmedPrice(i: number, item: CatalogueItem) {
    update((d) => {
      const price = itemPriceIn(item, d.currency, fx);
      if (price) d.lines[i] = withConfirmedPrice(d.lines[i], item, price, d.currency);
    });
  }

  /** A new line from a confirmed item, built the way a save builds it (the item fills the description and lists). */
  function addCatalogue() {
    const item = usable.find((c) => c.id === pick);
    if (!item) return;
    update((d) => {
      const price = itemPriceIn(item, d.currency, fx);
      if (!price) return;
      const fresh: ProposalLine = {
        kind: "needs_owner_price",
        line_id: lineId(d.lines),
        name: item.name,
        description: "",
        category: item.category,
        unit: item.unit,
        quantity: 1,
        optional: false,
        deliverables: [],
        onboarding_requirements: [],
      };
      d.lines.push(withConfirmedPrice(fresh, item, price, d.currency));
    });
    setPick("");
  }

  /**
   * A switch of currency re-prices every catalogue line: converted at CC's rate, or waiting for a price when there
   * is none. A price CC typed stays as he typed it, so he is asked to check it.
   */
  function changeCurrency(next: Currency) {
    const typed = p.lines.some((l) => l.kind === "owner_set");
    update((d) => {
      d.currency = next;
      d.lines = d.lines.map((l): ProposalLine => {
        if (l.kind !== "catalogue") return l;
        const item = catalogue.find((c) => c.id === l.item_id && c.status === "confirmed");
        const price = item ? itemPriceIn(item, next, fx) : null;
        if (item && price) return withConfirmedPrice(l, item, price, next);
        const { kind: _kind, sku, item_id: _id, item_version: _v, unit_price_cents: _c, currency: _cur, fx: _fx, ...rest } = l;
        return { ...rest, kind: "needs_owner_price", suggested_sku: sku };
      });
    });
    setMessage(typed ? `Prices are now in ${next}. The prices you typed stay as typed: check them.` : `Prices are now in ${next}.`);
  }

  async function save() {
    setBusy(true);
    setMessage(null);
    const r = await postAction(engagementId, "save_proposal", { content: p, expected_row_version: rv });
    setBusy(false);
    if (!r.ok) {
      setMessage(describeError(r));
      return;
    }
    if (typeof r.row_version === "number") setRv(r.row_version);
    setDirty(false);
    setMessage("Saved.");
    router.refresh();
  }

  return (
    <div className="grid gap-5">
      <div className="sticky top-0 z-10 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-hairline bg-bg-panel px-4 py-2.5">
        <div className="text-sm text-fg-muted">
          Total <span className="font-semibold tabular-nums text-fg">{money(totals.total_cents)}</span>, due now <span className="font-semibold tabular-nums text-fg">{money(totals.due_now_cents)}</span>
          {dirty ? <span className="ml-2 text-status-warm">Unsaved changes</span> : null}
          {!dirty && staleWords && editable ? <span className="ml-2 text-status-warm">{staleWords}</span> : null}
          {message ? <span className="ml-2 text-fg">{message}</span> : null}
        </div>
        {editable ? (
          <button type="button" className="btn-primary" onClick={save} disabled={busy || !(dirty || staleWords)}>
            Save proposal
          </button>
        ) : null}
      </div>

      {blockers.length ? (
        <div className="rounded-lg border border-hairline bg-bg-panel px-4 py-3">
          <div className="text-sm font-medium text-fg">Before this can go to final approval</div>
          <ul className="mt-1 grid gap-1 text-[13px] text-status-hot">
            {blockers.map((b, i) => (
              <li key={i}>{b}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <section className="grid gap-3 rounded-xl border border-hairline bg-bg-panel p-4">
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <div className="label">Currency</div>
            <select className="select" disabled={disabled} value={p.currency} onChange={(e) => changeCurrency(e.target.value as Currency)}>
              <option value="CAD">CAD</option>
              <option value="USD">USD</option>
            </select>
          </div>
          {p.lines.some((l) => l.kind === "catalogue" && l.fx) && rateWords ? (
            <div className="text-[13px] text-fg-muted">Converted from the catalogue at {rateWords}.</div>
          ) : null}
          <div className="text-[13px] text-fg-muted">
            Tax:{" "}
            {settings.tax
              ? settings.tax.mode === "registered"
                ? `${settings.tax.label} ${(settings.tax.rate_bps / 100).toFixed(2)}%`
                : "not registered, no tax added"
              : (
                <>
                  not set yet.{" "}
                  <Link href="/ai-audits/settings" className="font-medium text-fg underline underline-offset-2">
                    Set it in AI audit settings
                  </Link>
                </>
              )}
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-hairline text-left text-[12px] text-fg-muted">
                <th className="py-2 pr-3 font-medium">Item</th>
                <th className="py-2 pr-3 font-medium">Price from</th>
                <th className="py-2 pr-3 text-right font-medium">Qty</th>
                <th className="py-2 pr-3 text-right font-medium">Unit price</th>
                <th className="py-2 pr-3 font-medium">Optional</th>
                <th className="py-2 font-medium" />
              </tr>
            </thead>
            <tbody>
              {p.lines.map((l, i) => (
                <tr key={l.line_id} className="border-b border-hairline align-top">
                  <td className="py-2 pr-3">
                    <input className="input" disabled={disabled || l.kind === "catalogue"} value={l.name} onChange={(e) => update((d) => void (d.lines[i].name = e.target.value))} />
                    <textarea className="textarea mt-2" style={{ minHeight: 56 }} disabled={disabled} placeholder="Description shown to the client" value={l.description} onChange={(e) => update((d) => void (d.lines[i].description = e.target.value))} />
                  </td>
                  <td className="py-2 pr-3 text-[13px] text-fg-muted">
                    {l.kind === "catalogue" ? `Catalogue (${l.sku} v${l.item_version})` : l.kind === "owner_set" ? "Your price" : "Needs your price"}
                    {l.kind === "catalogue" && l.fx ? (
                      <div className="mt-0.5 text-[11px] text-fg-dim">
                        Converted from {l.fx.from_currency} {formatMoney(l.fx.from_unit_price_cents, l.fx.from_currency)} at {rateText(l.fx.rate_ppm)} ({l.fx.as_of})
                      </div>
                    ) : null}
                    {l.kind === "needs_owner_price" && l.suggested_sku ? (
                      (() => {
                        const match = usable.find((c) => c.sku === l.suggested_sku);
                        return match ? (
                          !disabled ? (
                            <button type="button" className="btn-secondary mt-1.5 block" onClick={() => takeConfirmedPrice(i, match)}>
                              Use the confirmed price ({formatMoney(priceOf(match)?.unit_price_cents ?? 0, p.currency)})
                            </button>
                          ) : null
                        ) : (
                          <div className="mt-1 text-[11px] text-fg-dim">
                            Suggested: {l.suggested_sku}, not confirmed yet.{" "}
                            <Link href="/ai-audits/catalogue" className="underline underline-offset-2">
                              Confirm it
                            </Link>
                          </div>
                        );
                      })()
                    ) : null}
                  </td>
                  <td className="py-2 pr-3 text-right">
                    <NumberInput
                      className="input w-20 text-right tabular-nums"
                      aria-label="Quantity"
                      disabled={disabled || (l.kind === "catalogue" && l.unit !== "per_unit")}
                      value={l.quantity}
                      emptyValue={1}
                      toValue={(n) => (Number.isInteger(n) && n >= 1 && n <= 1000 ? n : null)}
                      onChange={(n) => update((d) => void (d.lines[i].quantity = n ?? 1))}
                    />
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums">
                    {l.kind === "catalogue" ? (
                      money(l.unit_price_cents)
                    ) : (
                      <NumberInput
                        className="input w-32 text-right tabular-nums"
                        aria-label="Unit price"
                        disabled={disabled || !isOwner}
                        placeholder={isOwner ? "price" : "owner sets it"}
                        value={l.kind === "owner_set" ? l.unit_price_cents : null}
                        format={(c) => String(c / 100)}
                        toValue={(dollars) => {
                          const cents = Math.round(dollars * 100);
                          return cents > 0 && cents <= 100_000_000 ? cents : null;
                        }}
                        onChange={(cents) =>
                          update((d) => {
                            const base = d.lines[i];
                            if (cents === null) {
                              d.lines[i] = { ...base, kind: "needs_owner_price" } as ProposalLine;
                            } else {
                              d.lines[i] = { ...base, kind: "owner_set", unit_price_cents: cents, set_by: "", set_at: "" } as ProposalLine;
                            }
                          })
                        }
                      />
                    )}
                    <div className="text-[11px] text-fg-dim">{l.unit === "per_month" ? "a month" : l.unit === "per_unit" ? `per ${l.unit_label || "unit"}` : "one-time"}</div>
                  </td>
                  <td className="py-2 pr-3">
                    <input type="checkbox" disabled={disabled} checked={l.optional} onChange={(e) => update((d) => void (d.lines[i].optional = e.target.checked))} aria-label="Optional add-on" />
                  </td>
                  <td className="py-2">
                    {!disabled ? (
                      <button type="button" className="btn-danger" onClick={() => update((d) => void d.lines.splice(i, 1))}>
                        Remove
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {!disabled ? (
          <div className="flex flex-wrap items-end gap-2">
            <div>
              <div className="label">Add from the confirmed catalogue ({p.currency})</div>
              <select className="select" value={pick} onChange={(e) => setPick(e.target.value)}>
                <option value="">{usable.length ? "Choose an item" : "No confirmed items in this currency"}</option>
                {usable.map((c) => {
                  const price = priceOf(c);
                  return (
                    <option key={c.id} value={c.id}>
                      {c.name}, {formatMoney(price?.unit_price_cents ?? 0, p.currency)}
                      {c.unit === "per_month" ? " a month" : ""}
                      {price?.fx ? ` (${c.currency} ${formatMoney(c.price_cents ?? 0, c.currency)})` : ""}
                    </option>
                  );
                })}
              </select>
            </div>
            <button type="button" className="btn-secondary" disabled={!pick} onClick={addCatalogue}>
              Add item
            </button>
            {!usable.length ? (
              catalogue.some((c) => c.status === "confirmed") && !fx ? (
                <span className="self-center text-[13px] text-fg-muted">
                  The catalogue is priced in another currency. To price this proposal in {p.currency}, set the exchange rate in{" "}
                  <Link href="/ai-audits/settings" className="font-medium text-fg underline underline-offset-2">
                    AI audit settings
                  </Link>
                  , or type your own prices.
                </span>
              ) : (
                <span className="self-center text-[13px] text-fg-muted">
                  No confirmed prices in {p.currency} yet.{" "}
                  <Link href="/ai-audits/catalogue" className="font-medium text-fg underline underline-offset-2">
                    Confirm prices in the catalogue
                  </Link>
                </span>
              )
            ) : null}
            <button
              type="button"
              className="btn-secondary"
              onClick={() =>
                update((d) =>
                  void d.lines.push({
                    kind: "needs_owner_price",
                    line_id: lineId(d.lines),
                    name: "Custom work",
                    description: "",
                    category: "implementation" as CatalogueCategory,
                    unit: "fixed" as CatalogueUnit,
                    quantity: 1,
                    optional: false,
                    deliverables: [],
                    onboarding_requirements: [],
                  }),
                )
              }
            >
              Add custom line
            </button>
          </div>
        ) : null}
        <p className="text-[12px] text-fg-dim">
          Custom line categories: {CATALOGUE_CATEGORIES.join(", ")}. Units: {CATALOGUE_UNITS.join(", ")}. A custom line stays &quot;needs your price&quot; until {isOwner ? "you type one" : "the owner types one"}.
        </p>
      </section>

      <section className="grid gap-3 rounded-xl border border-hairline bg-bg-panel p-4">
        <h3 className="text-sm font-semibold text-fg">Totals</h3>
        <dl className="grid max-w-md grid-cols-2 gap-1 text-sm">
          <dt className="text-fg-muted">Subtotal</dt>
          <dd className="text-right tabular-nums">{money(totals.subtotal_cents)}</dd>
          <dt className="text-fg-muted">Tax</dt>
          <dd className="text-right tabular-nums">{money(totals.tax_cents)}</dd>
          <dt className="font-medium text-fg">Total</dt>
          <dd className="text-right font-medium tabular-nums">{money(totals.total_cents)}</dd>
          <dt className="text-fg-muted">Due now</dt>
          <dd className="text-right tabular-nums">{money(totals.due_now_cents)}</dd>
          <dt className="text-fg-muted">Monthly after launch</dt>
          <dd className="text-right tabular-nums">{money(totals.monthly_cents)}</dd>
          <dt className="text-fg-muted">Optional add-ons</dt>
          <dd className="text-right tabular-nums">{money(totals.optional_cents)}</dd>
        </dl>
      </section>

      <section className="grid gap-3 rounded-xl border border-hairline bg-bg-panel p-4 md:grid-cols-2">
        <div>
          <div className="label">Payment terms</div>
          <select
            className="select"
            disabled={disabled}
            value={p.payment_terms.kind}
            onChange={(e) =>
              update((d) => {
                d.payment_terms = e.target.value === "deposit" ? { kind: "deposit", deposit_bps: settings.deposit_bps ?? 5_000, balance_due: "at launch" } : { kind: "full" };
              })
            }
          >
            <option value="full">Full payment to start</option>
            <option value="deposit">Deposit to start, balance later</option>
          </select>
        </div>
        {p.payment_terms.kind === "deposit" ? (
          <div className="grid grid-cols-2 gap-2">
            <div>
              <div className="label">Deposit %</div>
              <input
                className="input"
                inputMode="numeric"
                disabled={disabled}
                value={String(p.payment_terms.deposit_bps / 100)}
                onChange={(e) => update((d) => void (d.payment_terms.kind === "deposit" && (d.payment_terms.deposit_bps = Math.round((Number(e.target.value) || 0) * 100))))}
              />
            </div>
            <div>
              <div className="label">Balance due</div>
              <input className="input" disabled={disabled} value={p.payment_terms.balance_due} onChange={(e) => update((d) => void (d.payment_terms.kind === "deposit" && (d.payment_terms.balance_due = e.target.value)))} />
            </div>
          </div>
        ) : null}
        <div>
          <div className="label">Valid until</div>
          <input className="input" type="date" disabled={disabled} value={p.valid_until} onChange={(e) => update((d) => void (d.valid_until = e.target.value))} />
        </div>
      </section>

      <section className="grid gap-3 rounded-xl border border-hairline bg-bg-panel p-4">
        <h3 className="text-sm font-semibold text-fg">Phases, exclusions and terms</h3>
        {p.phases.map((ph, i) => (
          <div key={i} className="grid gap-2 md:grid-cols-3">
            <input className="input" disabled={disabled} value={ph.name} placeholder="Phase name" onChange={(e) => update((d) => void (d.phases[i].name = e.target.value))} />
            <input className="input md:col-span-2" disabled={disabled} value={ph.description} placeholder="What happens in it" onChange={(e) => update((d) => void (d.phases[i].description = e.target.value))} />
          </div>
        ))}
        {!disabled ? (
          <button type="button" className="btn-secondary justify-self-start" onClick={() => update((d) => void d.phases.push({ name: "", description: "", line_ids: [] }))}>
            Add phase
          </button>
        ) : null}
        <div>
          <div className="label">Not included (one per line)</div>
          <textarea className="textarea" disabled={disabled} defaultValue={p.exclusions.join("\n")} onChange={(e) => update((d) => void (d.exclusions = e.target.value.split("\n").map((x) => x.trim()).filter(Boolean)))} />
        </div>
        <div>
          <div className="label">Terms (one per line)</div>
          <textarea className="textarea" disabled={disabled} defaultValue={p.terms.join("\n")} onChange={(e) => update((d) => void (d.terms = e.target.value.split("\n").map((x) => x.trim()).filter(Boolean)))} />
        </div>
      </section>

      <section className="grid gap-3 rounded-xl border border-hairline bg-bg-panel p-4">
        <h3 className="text-sm font-semibold text-fg">Delivery email</h3>
        <p className="text-[13px] text-fg-muted">
          Sent only when you approve the final audit. {AUDIT_LINK_PLACEHOLDER} becomes the client&apos;s private link.
        </p>
        <div className="grid gap-3 md:grid-cols-2">
          <div>
            <div className="label">To</div>
            <input className="input" disabled={disabled} value={p.delivery_email.to} onChange={(e) => update((d) => void (d.delivery_email.to = e.target.value))} />
          </div>
          <div>
            <div className="label">Subject</div>
            <input className="input" disabled={disabled} value={p.delivery_email.subject} onChange={(e) => update((d) => void (d.delivery_email.subject = e.target.value))} />
          </div>
        </div>
        <textarea className="textarea" style={{ minHeight: 180 }} disabled={disabled} value={p.delivery_email.body} onChange={(e) => update((d) => void (d.delivery_email.body = e.target.value))} />
      </section>
    </div>
  );
}
