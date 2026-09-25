"use client";

/**
 * Wise (the business bank) in Finances: is it connected, what is in each
 * balance, the receiving details invoices print, and "Check for Wise
 * payments" — which records exact matches and lists the rest to confirm.
 * Below that, the bank feed ("Sync Wise": Wise activity into Transactions on
 * Business chequing) and the opening balance (preview, then an explicit post).
 *
 * Loads after the page renders (GET /api/founders/finances/wise), so a slow
 * or unreachable Wise never holds up the tab it sits on. Account numbers are
 * masked here; the PDF a client receives prints them whole.
 *
 * Mount on the business book only: <WiseCard />
 */

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { Card, Tag } from "@/components/Card";
import { formatCents } from "@/lib/founders-finances/money";
import { WISE_FEED_OFF_MESSAGE, WISE_FEED_WRITES_ENABLED } from "@/lib/founders-finances/wise-feed";
import { inputClass, labelClass, primaryButton, quietButton } from "./ui";

type Details = { currency: string; accountHolder: string; bankName: string; bankAddress: string; fields: Array<{ label: string; value: string }> };
type Status = {
  configured: boolean;
  ready: boolean;
  profileName: string | null;
  balances: Array<{ currency: string; cents: number; display: string }>;
  details: Record<string, Details | null>;
  detailIssues: Record<string, string>;
  error: string | null;
};
type Deposit = { wise_ref: string; date: string; currency: string; amount_cents: number; fee_cents: number; sender: string; reference: string };
type Match = { deposit: Deposit; invoice_id: string; invoice_number: string; customer: string; balance_cents: number; reason: string };
type CheckResult = {
  days: number;
  deposits_seen: number;
  recorded: number;
  exact: Array<Match & { payment_id: string | null }>;
  needs_confirmation: Match[];
  errors: Array<{ wise_ref: string; invoice_number: string; message: string }>;
};
type OpeningAction = "none" | "keep" | "post" | "replace" | "remove";
type OpeningLine = {
  currency: string;
  wise_cents: number;
  books_cents: number;
  pending_cents: number;
  pending_lines: number;
  undecided_lines: number;
  difference_cents: number;
  existing: { entry_id: string; date: string; cents: number } | null;
  action: OpeningAction;
  entry_id: string | null;
};
type Opening = { date: string; dry_run: boolean; lines: OpeningLine[]; blocked: string | null };

const writes = (l: OpeningLine) => l.action === "post" || l.action === "replace" || l.action === "remove";

/** One sentence per currency: what posting does (preview) or did (after posting). */
function openingSentence(l: OpeningLine, date: string, done: boolean): string {
  const amount = formatCents(l.difference_cents, l.currency);
  const old = l.existing ? `the ${formatCents(l.existing.cents, l.currency)} opening balance posted for ${l.existing.date}` : "";
  switch (l.action) {
    case "keep":
      return `${l.currency}: the opening balance for ${date} is already right (${amount}); nothing to change.`;
    case "none":
      return `${l.currency}: Business chequing already matches Wise on ${date}; no opening balance needed.`;
    case "post":
      return done ? `${l.currency}: posted ${amount} for ${date}.` : `${l.currency}: posts ${amount} for ${date} against Retained earnings.`;
    case "replace":
      return done
        ? `${l.currency}: replaced ${old} — reversed it and posted ${amount} for ${date}.`
        : `${l.currency}: replaces ${old}. That entry is reversed and ${amount} is posted for ${date}, so there is still exactly one.`;
    case "remove":
      return done ? `${l.currency}: reversed ${old}; none is needed.` : `${l.currency}: reverses ${old}; with it gone chequing already matches Wise on ${date}.`;
  }
}

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

const ENDPOINT = "/api/founders/finances/wise";

async function call(body?: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetch(ENDPOINT, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : { cache: "no-store" });
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok || !json || json.ok !== true) {
    throw new Error((json && typeof json.message === "string" && json.message) || (json && typeof json.error === "string" && json.error) || `Request failed (${res.status})`);
  }
  return json;
}

export function WiseCard() {
  const router = useRouter();
  const [status, setStatus] = useState<Status | null>(null);
  const [methodSupported, setMethodSupported] = useState(true);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [result, setResult] = useState<CheckResult | null>(null);
  const [since, setSince] = useState("");
  const [openingDate, setOpeningDate] = useState("");
  const [opening, setOpening] = useState<Opening | null>(null);

  const load = useCallback(async () => {
    try {
      const j = await call();
      setStatus(j.status as Status);
      setMethodSupported(j.method_supported === true);
      setLoadErr(null);
    } catch (e) {
      setLoadErr(e instanceof Error ? e.message : "Could not load Wise status.");
    }
  }, []);

  useEffect(() => {
    // Dates are filled in the browser, so the server render and the client agree.
    setSince(daysAgo(90));
    setOpeningDate(daysAgo(1));
    void load();
  }, [load]);

  async function sync() {
    setBusy("sync");
    setMsg(null);
    try {
      const j = await call({ action: "sync", since });
      setMsg({ tone: "ok", text: String(j.message || "Synced.") });
      router.refresh();
    } catch (e) {
      setMsg({ tone: "err", text: e instanceof Error ? e.message : "Sync failed." });
    } finally {
      setBusy(null);
    }
  }

  async function openingBalance(post: boolean) {
    if (post) {
      const moves = (opening?.lines || []).filter(writes).map((l) => openingSentence(l, openingDate, false));
      if (!window.confirm(`So Business chequing equals Wise from the end of ${openingDate}:\n\n${moves.join("\n")}\n\nGo ahead?`)) return;
    }
    setBusy(post ? "opening_post" : "opening_preview");
    setMsg(null);
    try {
      const j = await call({ action: post ? "opening_post" : "opening_preview", date: openingDate });
      const result = j.result as Opening;
      setOpening(result);
      // Said from the result itself: it knows a replacement from a first post and a removal from "already matches".
      if (post) setMsg({ tone: "ok", text: result.lines.map((l) => openingSentence(l, result.date, true)).join(" ") });
      if (post) router.refresh();
    } catch (e) {
      setMsg({ tone: "err", text: e instanceof Error ? e.message : "Failed." });
    } finally {
      setBusy(null);
    }
  }

  async function check() {
    setBusy("check");
    setMsg(null);
    try {
      const j = await call({ action: "check", days: 30 });
      setResult(j.result as CheckResult);
      setMsg({ tone: "ok", text: String(j.message || "Checked.") });
      if ((j.result as CheckResult).recorded > 0) router.refresh();
    } catch (e) {
      setMsg({ tone: "err", text: e instanceof Error ? e.message : "Check failed." });
    } finally {
      setBusy(null);
    }
  }

  async function decide(action: "confirm" | "dismiss", m: Match) {
    if (action === "confirm" && !window.confirm(`Record ${formatCents(m.deposit.amount_cents, m.deposit.currency)} from ${m.deposit.sender || "this deposit"} as payment for ${m.invoice_number}?`)) return;
    const key = `${action}:${m.deposit.wise_ref}:${m.invoice_id}`;
    setBusy(key);
    setMsg(null);
    try {
      const j = await call({ action, wise_ref: m.deposit.wise_ref, invoice_id: m.invoice_id });
      setMsg({ tone: "ok", text: String(j.message || "Done.") });
      // A confirmed deposit is spoken for: drop every suggestion that uses it, not only this one.
      setResult((r) =>
        r && {
          ...r,
          needs_confirmation: r.needs_confirmation.filter((x) =>
            action === "confirm" ? x.deposit.wise_ref !== m.deposit.wise_ref : !(x.deposit.wise_ref === m.deposit.wise_ref && x.invoice_id === m.invoice_id),
          ),
        },
      );
      if (action === "confirm") router.refresh();
    } catch (e) {
      setMsg({ tone: "err", text: e instanceof Error ? e.message : "Failed." });
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card id="wise" title="Wise" subtitle="The business bank. One-off invoices are paid by bank transfer into these accounts, with the invoice number as the reference.">
      <div className="space-y-4 text-sm">
        {loadErr ? (
          <p className="text-status-hot">{loadErr}</p>
        ) : !status ? (
          <p className="text-fg-dim">Checking Wise…</p>
        ) : !status.configured ? (
          <p className="text-status-warm">{status.error}</p>
        ) : status.error ? (
          <p className="text-status-hot">{status.error}</p>
        ) : (
          <>
            <p>
              Connected to <span className="font-semibold">{status.profileName || "the Wise business profile"}</span>{" "}
              {status.ready ? <Tag tone="engaged">ready</Tag> : <Tag tone="warm">no receiving details</Tag>}
            </p>
            {status.balances.length > 0 && (
              <div className="flex flex-wrap gap-x-6 gap-y-1">
                {status.balances.map((b) => (
                  <div key={b.currency}>
                    <div className="text-[10px] font-bold uppercase tracking-[0.12em] text-fg-muted">{b.currency} balance</div>
                    <div className="tabular-nums text-fg">{b.display}</div>
                  </div>
                ))}
              </div>
            )}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {["CAD", "USD"].map((cur) => {
                const d = status.details[cur];
                return (
                  <div key={cur} className="rounded-md border border-bg-border bg-bg-deep p-3">
                    <div className="mb-1 text-[10px] font-bold uppercase tracking-[0.12em] text-fg-muted">{cur} invoices are paid into</div>
                    {d ? (
                      <dl className="space-y-0.5 text-xs">
                        <div className="flex justify-between gap-3">
                          <dt className="text-fg-muted">Account holder</dt>
                          <dd>{d.accountHolder}</dd>
                        </div>
                        {d.bankName && (
                          <div className="flex justify-between gap-3">
                            <dt className="text-fg-muted">Bank</dt>
                            <dd className="text-right">{d.bankName}</dd>
                          </div>
                        )}
                        {d.fields.map((f) => (
                          <div key={f.label} className="flex justify-between gap-3">
                            <dt className="text-fg-muted">{f.label}</dt>
                            <dd className="font-mono">{f.value}</dd>
                          </div>
                        ))}
                      </dl>
                    ) : (
                      <p className="text-xs text-status-warm">{status.detailIssues[cur] || `No ${cur} receiving details.`}</p>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}

        {!methodSupported && (
          <p className="text-xs text-status-warm">
            {"Invoices can't offer a bank transfer right now, so every invoice goes out with the card link."}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className={primaryButton} disabled={busy !== null || !status?.ready} onClick={check}>
            {busy === "check" ? "Checking…" : "Check for Wise payments"}
          </button>
          <span className="text-xs text-fg-dim">Last 30 days. A deposit is recorded on its own only when its reference names the invoice and the amount matches.</span>
        </div>
        {msg && <p className={`text-xs ${msg.tone === "ok" ? "text-status-engaged" : "text-status-hot"}`}>{msg.text}</p>}

        {result && result.exact.length > 0 && (
          <div>
            <div className="mb-1 text-[10px] font-bold uppercase tracking-[0.12em] text-fg-muted">Recorded</div>
            <ul className="space-y-1 text-xs">
              {result.exact.map((m) => (
                <li key={m.deposit.wise_ref}>
                  {m.invoice_number} — {formatCents(m.deposit.amount_cents, m.deposit.currency)} from {m.deposit.sender || "unknown sender"} on {m.deposit.date}
                </li>
              ))}
            </ul>
          </div>
        )}

        {result && result.needs_confirmation.length > 0 && (
          <div>
            <div className="mb-1 text-[10px] font-bold uppercase tracking-[0.12em] text-fg-muted">Needs your confirmation</div>
            <ul className="space-y-2">
              {result.needs_confirmation.map((m) => (
                <li key={`${m.deposit.wise_ref}:${m.invoice_id}`} className="rounded-md border border-bg-border p-2.5 text-xs">
                  <div>
                    <span className="font-semibold tabular-nums">{formatCents(m.deposit.amount_cents, m.deposit.currency)}</span> from {m.deposit.sender || "unknown sender"} on {m.deposit.date}
                    {m.deposit.reference && <> · reference &ldquo;{m.deposit.reference}&rdquo;</>}
                  </div>
                  <div className="text-fg-muted">
                    Could be {m.invoice_number} ({m.customer}, {formatCents(m.balance_cents, m.deposit.currency)} due) — {m.reason}
                  </div>
                  <div className="mt-1.5 flex gap-2">
                    <button type="button" className={primaryButton} disabled={busy !== null} onClick={() => decide("confirm", m)}>
                      Record against {m.invoice_number}
                    </button>
                    <button type="button" className={quietButton} disabled={busy !== null} onClick={() => decide("dismiss", m)}>
                      Not this invoice
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}

        {result && result.errors.length > 0 && (
          <ul className="space-y-1 text-xs text-status-hot">
            {result.errors.map((e) => (
              <li key={e.wise_ref}>
                {e.invoice_number}: {e.message}
              </li>
            ))}
          </ul>
        )}

        <div className="space-y-2 border-t border-bg-border pt-3">
          <div className="text-[10px] font-bold uppercase tracking-[0.12em] text-fg-muted">Bank feed</div>
          <p className="text-xs text-fg-dim">
            Brings Wise activity (CAD and USD) into Transactions on Business chequing. A payment that is already an expense in Bills is matched to it, and a deposit
            already recorded against an invoice is set aside, so nothing is counted twice. Stripe payouts are booked as transfers from Stripe clearing (only when
            Stripe clearing holds them in the currency Stripe paid out from) and currency conversions through Currency exchange clearing. A line that may already
            be on the books — it could be one of several expenses, part of one, or inside the opening balance — is held with a note saying why, and no rule
            ever books it; you decide it. Everything else waits for you or your rules to categorise. Syncing again never adds a line twice.
          </p>
          <div className="flex flex-wrap items-end gap-2">
            <div>
              <label className={labelClass}>From</label>
              <input type="date" className={inputClass} value={since} onChange={(e) => setSince(e.target.value)} />
            </div>
            <button type="button" className={primaryButton} disabled={!WISE_FEED_WRITES_ENABLED || busy !== null || !status?.ready || !since} onClick={sync}>
              {busy === "sync" ? "Syncing…" : "Sync Wise"}
            </button>
          </div>
        </div>

        <div className="space-y-2 border-t border-bg-border pt-3">
          <div className="text-[10px] font-bold uppercase tracking-[0.12em] text-fg-muted">Opening balance</div>
          {!WISE_FEED_WRITES_ENABLED && <p className="text-xs text-status-warm">{WISE_FEED_OFF_MESSAGE}</p>}
          <p className="text-xs text-fg-dim">
            Sets Business chequing to what Wise actually held at the end of a day, one entry per currency against Retained earnings. There is only ever one per
            currency: posting again replaces it (the old entry is reversed). Wise lines not yet categorised count as if they were, so categorising them later
            keeps chequing equal to Wise. A bank payment matched to an expense dated on the other side of the day counts on the bank&apos;s date, and a voided
            entry counts as never booked, so chequing equals Wise from the later of the two dates on. If the books on or before the day change afterwards, the
            next sync says so and you re-post. Preview first; nothing is posted until you confirm.
          </p>
          <div className="flex flex-wrap items-end gap-2">
            <div>
              <label className={labelClass}>End of</label>
              <input
                type="date"
                className={inputClass}
                value={openingDate}
                onChange={(e) => {
                  setOpeningDate(e.target.value);
                  setOpening(null);
                }}
              />
            </div>
            <button type="button" className={quietButton} disabled={busy !== null || !status?.ready || !openingDate} onClick={() => openingBalance(false)}>
              {busy === "opening_preview" ? "Checking…" : "Preview"}
            </button>
          </div>
          {opening && (
            <>
              <table className="w-full text-xs tabular-nums">
                <thead>
                  <tr className="text-left text-fg-muted">
                    <th className="py-1 font-normal">Currency</th>
                    <th className="py-1 text-right font-normal">Wise</th>
                    <th className="py-1 text-right font-normal">Books</th>
                    <th className="py-1 text-right font-normal">Difference</th>
                  </tr>
                </thead>
                <tbody>
                  {opening.lines.map((l) => (
                    <tr key={l.currency} className="border-t border-bg-border">
                      <td className="py-1">{l.currency}</td>
                      <td className="py-1 text-right">{formatCents(l.wise_cents, l.currency)}</td>
                      <td className="py-1 text-right">{formatCents(l.books_cents, l.currency)}</td>
                      <td className="py-1 text-right">{l.entry_id ? "posted" : formatCents(l.difference_cents, l.currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {opening.dry_run && (
                <ul className="space-y-1 text-xs text-fg-dim">
                  {opening.lines.map((l) => (
                    <li key={l.currency}>
                      {l.existing && (
                        <span className="text-status-warm">
                          An opening balance is already posted for {l.currency}: {formatCents(l.existing.cents, l.currency)} on {l.existing.date}.{" "}
                        </span>
                      )}
                      {openingSentence(l, opening.date, false)}
                      {l.pending_lines > 0 && (
                        <>
                          {" "}
                          Books include {l.pending_lines} Wise line(s) not yet categorised ({formatCents(l.pending_cents, l.currency)}).
                        </>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {opening.dry_run && opening.blocked && <p className="text-xs text-status-warm">{opening.blocked}</p>}
              {opening.dry_run && opening.lines.some(writes) && (
                <button type="button" className={primaryButton} disabled={!WISE_FEED_WRITES_ENABLED || busy !== null || !!opening.blocked} onClick={() => openingBalance(true)}>
                  {busy === "opening_post"
                    ? "Posting…"
                    : opening.lines.some((l) => l.action === "replace" || l.action === "remove")
                      ? `Replace the opening balance with ${opening.date}`
                      : `Post opening balance for ${opening.date}`}
                </button>
              )}
              {opening.dry_run && !opening.blocked && !opening.lines.some(writes) && (
                <p className="text-xs text-status-engaged">Business chequing already matches Wise on {opening.date}.</p>
              )}
            </>
          )}
        </div>
      </div>
    </Card>
  );
}
