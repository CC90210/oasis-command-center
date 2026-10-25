"use client";

/**
 * The price catalogue. Every item starts proposed, copied from the file it
 * came from (shown with each version). Only the owner confirms a price; a
 * confirmed price never changes, so an edit is a new proposed version, and
 * confirming it retires the old one.
 */
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { formatMoney, type CatalogueItem } from "@/lib/ai-audit/catalogue";
import { CATALOGUE_CATEGORIES, CATALOGUE_UNITS } from "@/lib/ai-audit/rules";
import { describeError, postJson } from "./api";

type Edit = {
  sku: string;
  name: string;
  description: string;
  category: string;
  unit: string;
  unit_label: string;
  price: string;
  currency: string;
  deliverables: string;
  onboarding_requirements: string;
};

function toEdit(i: CatalogueItem): Edit {
  return {
    sku: i.sku,
    name: i.name,
    description: i.description,
    category: i.category,
    unit: i.unit,
    unit_label: i.unit_label ?? "",
    price: i.price_cents === null ? "" : String(i.price_cents / 100),
    currency: i.currency,
    deliverables: i.deliverables.join("\n"),
    onboarding_requirements: i.onboarding_requirements.join("\n"),
  };
}

const STATUS_WORDS: Record<string, string> = { proposed: "Proposed", confirmed: "Confirmed", retired: "Retired" };

export function CatalogueManager({ items, isOwner }: { items: CatalogueItem[]; isOwner: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [editing, setEditing] = useState<Edit | null>(null);
  const bySku = useMemo(() => {
    const m = new Map<string, CatalogueItem[]>();
    for (const i of items) m.set(i.sku, [...(m.get(i.sku) ?? []), i]);
    return [...m.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [items]);

  async function call(body: Record<string, unknown>, done: string) {
    setBusy(true);
    setMessage(null);
    const r = await postJson("/api/ai-audit/catalogue", body);
    setBusy(false);
    if (!r.ok) {
      setMessage(describeError(r));
      return false;
    }
    setMessage(done);
    router.refresh();
    return true;
  }

  async function saveEdit() {
    if (!editing) return;
    const cents = editing.price.trim() ? Math.round(Number(editing.price.replace(/[$,\s]/g, "")) * 100) : null;
    const ok = await call(
      {
        action: "propose",
        item: {
          sku: editing.sku,
          name: editing.name,
          description: editing.description,
          category: editing.category,
          unit: editing.unit,
          unit_label: editing.unit_label,
          price_cents: cents,
          currency: editing.currency,
          deliverables: editing.deliverables,
          onboarding_requirements: editing.onboarding_requirements,
          source_ref: { file: "entered by the owner", note: "Edited in the catalogue screen." },
        },
      },
      "New proposed version saved. Confirm it to make it the price.",
    );
    if (ok) setEditing(null);
  }

  return (
    <div className="grid gap-5">
      {message ? <div className="rounded-lg border border-hairline bg-bg-panel px-4 py-2.5 text-sm text-fg">{message}</div> : null}
      {items.length === 0 ? (
        <div className="rounded-xl border border-hairline bg-bg-panel p-5 text-sm text-fg-muted">
          The catalogue is empty.{" "}
          {isOwner ? (
            <button type="button" className="btn-primary ml-2" disabled={busy} onClick={() => call({ action: "seed" }, "Seeded from the existing price files. Every item is proposed until you confirm it.")}>
              Seed from the existing price files
            </button>
          ) : (
            "The owner seeds it."
          )}
        </div>
      ) : null}
      {bySku.map(([sku, versions]) => {
        const current = versions[0];
        return (
          <section key={sku} className="rounded-xl border border-hairline bg-bg-panel">
            <header className="flex flex-wrap items-start justify-between gap-3 border-b border-hairline px-4 py-3">
              <div>
                <h2 className="text-sm font-semibold text-fg">{current.name}</h2>
                <div className="text-[12px] text-fg-dim">
                  {sku}, {current.category}, {current.unit === "per_month" ? "monthly" : current.unit === "per_unit" ? `per ${current.unit_label || "unit"}` : "one-time"}
                </div>
              </div>
              <button type="button" className="btn-secondary" disabled={busy} onClick={() => setEditing(toEdit(current))}>
                Edit (new version)
              </button>
            </header>
            <ul className="divide-y divide-hairline text-sm">
              {versions.map((v) => (
                <li key={v.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5">
                  <div>
                    <span className="tabular-nums text-fg">{v.price_cents === null ? "No price" : formatMoney(v.price_cents, v.currency)}</span>
                    <span className="ml-2 text-fg-muted">
                      v{v.item_version}, {STATUS_WORDS[v.status]}
                    </span>
                    <div className="text-[12px] text-fg-dim">
                      From {v.source_ref.file}
                      {v.source_ref.line ? `:${v.source_ref.line}` : ""}
                      {v.source_ref.note ? `. ${v.source_ref.note}` : ""}
                    </div>
                  </div>
                  {isOwner ? (
                    <div className="flex gap-2">
                      {v.status === "proposed" ? (
                        <button type="button" className="btn-primary" disabled={busy || v.price_cents === null} onClick={() => call({ action: "confirm", item_id: v.id }, `${v.name} confirmed at ${v.price_cents === null ? "" : formatMoney(v.price_cents, v.currency)}.`)}>
                          Confirm this price
                        </button>
                      ) : null}
                      {v.status !== "retired" ? (
                        <button type="button" className="btn-danger" disabled={busy} onClick={() => call({ action: "retire", item_id: v.id }, `${v.name} v${v.item_version} retired.`)}>
                          Retire
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
            {editing && editing.sku === sku ? (
              <div className="grid gap-3 border-t border-hairline p-4 md:grid-cols-2">
                <div>
                  <div className="label">Name</div>
                  <input className="input" value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <div className="label">Price</div>
                    <input className="input tabular-nums" inputMode="decimal" value={editing.price} onChange={(e) => setEditing({ ...editing, price: e.target.value })} />
                  </div>
                  <div>
                    <div className="label">Currency</div>
                    <select className="select" value={editing.currency} onChange={(e) => setEditing({ ...editing, currency: e.target.value })}>
                      <option value="CAD">CAD</option>
                      <option value="USD">USD</option>
                    </select>
                  </div>
                </div>
                <div>
                  <div className="label">Category</div>
                  <select className="select" value={editing.category} onChange={(e) => setEditing({ ...editing, category: e.target.value })}>
                    {CATALOGUE_CATEGORIES.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <div className="label">Unit</div>
                    <select className="select" value={editing.unit} onChange={(e) => setEditing({ ...editing, unit: e.target.value })}>
                      {CATALOGUE_UNITS.map((u) => (
                        <option key={u} value={u}>
                          {u}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <div className="label">One unit is</div>
                    <input className="input" value={editing.unit_label} onChange={(e) => setEditing({ ...editing, unit_label: e.target.value })} placeholder="integration" />
                  </div>
                </div>
                <div className="md:col-span-2">
                  <div className="label">Description</div>
                  <textarea className="textarea" value={editing.description} onChange={(e) => setEditing({ ...editing, description: e.target.value })} />
                </div>
                <div>
                  <div className="label">Deliverables (one per line)</div>
                  <textarea className="textarea" value={editing.deliverables} onChange={(e) => setEditing({ ...editing, deliverables: e.target.value })} />
                </div>
                <div>
                  <div className="label">Onboarding needs (one per line)</div>
                  <textarea className="textarea" value={editing.onboarding_requirements} onChange={(e) => setEditing({ ...editing, onboarding_requirements: e.target.value })} />
                </div>
                <div className="flex gap-2 md:col-span-2">
                  <button type="button" className="btn-primary" disabled={busy} onClick={saveEdit}>
                    Save as a new proposed version
                  </button>
                  <button type="button" className="btn-secondary" disabled={busy} onClick={() => setEditing(null)}>
                    Cancel
                  </button>
                </div>
              </div>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}
