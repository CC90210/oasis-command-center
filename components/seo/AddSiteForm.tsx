"use client";

import Link from "next/link";
import { useId, useState, type FormEvent } from "react";
import { checkAccessOutcome } from "@/lib/seo/check-access-outcome";
import type { AccessResult, AddSiteResult } from "@/lib/seo/types";

type Site = AddSiteResult["site"];
type Phase =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "added"; site: Site; existed: boolean }
  | { kind: "checking"; site: Site; existed: boolean }
  | { kind: "access"; site: Site; existed: boolean; result: AccessResult }
  | { kind: "error"; message: string; site?: Site; existed?: boolean; code?: string };

/** The only 400 code that means the DOMAIN field is what's wrong; dpa_required, bad_is_test,
 * bad_json and any code this screen doesn't recognise must never mark the field invalid. */
const DOMAIN_ERROR_CODE = "bad_domain";

// text-white, not text-fg: text-fg (#ededef) on bg-accent-muted (#2563eb) is ~4.42:1, under the
// 4.5:1 AA floor; white on the same background is ~5.17:1. The hover darkens (never lightens, so
// it never tips white-on-blue the other way) to rgb(29 78 216) — the same colour .btn-primary in
// app/globals.css hovers to (white on it is ~6.70:1) — expressed as an arbitrary value because no
// accent-* token in tailwind.config.ts is that shade (accent/accent-muted are the only two steps).
const BTN = "rounded-md bg-accent-muted px-3 py-1.5 text-sm font-medium text-white hover:bg-[rgb(29_78_216)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-60";
const BTN2 = "rounded-md border border-bg-border-strong px-3 py-1.5 text-sm font-medium text-fg hover:bg-bg-elev focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-60";
const DOWN = "The SEO service did not answer. Try again in a minute.";

async function post(url: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> | null }> {
  try {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, json: await r.json().catch(() => null) };
  } catch {
    return { status: 0, json: null };
  }
}

export function AddSiteForm({ serviceAccount, base = "/seo", api = "/api/seo" }: { serviceAccount: string; base?: string; api?: string }) {
  const id = useId();
  const [domain, setDomain] = useState("");
  const [dpa, setDpa] = useState(false);
  const [isTest, setIsTest] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [copied, setCopied] = useState<"no" | "yes" | "failed">("no");

  const site = "site" in phase ? phase.site : undefined;
  const existed = "existed" in phase ? Boolean(phase.existed) : false;
  const busy = phase.kind === "saving" || phase.kind === "checking";

  async function add(e: FormEvent) {
    e.preventDefault();
    if (busy) return; // a second press while saving never sends a second add
    setPhase({ kind: "saving" });
    const r = await post(`${api}/sites`, { domain, dpa_confirmed: dpa, is_test: isTest });
    const s = r.json?.site as Site | undefined;
    if ((r.status === 201 || r.status === 409) && s) setPhase({ kind: "added", site: s, existed: r.status === 409 });
    else if (r.status === 400) {
      const code = typeof r.json?.code === "string" ? r.json.code : undefined;
      setPhase({ kind: "error", message: String(r.json?.error ?? "Check the domain and try again."), code });
    } else setPhase({ kind: "error", message: DOWN });
  }

  async function check() {
    if (!site || busy) return;
    setPhase({ kind: "checking", site, existed });
    const r = await post(`${api}/sites/${site.id}/check-access`, {});
    const outcome = checkAccessOutcome(r);
    if (outcome.kind === "ok") setPhase({ kind: "access", site, existed, result: outcome.result });
    else if (outcome.kind === "gone") setPhase({ kind: "error", message: "That site no longer exists. Reload the list." });
    else if (outcome.kind === "bad_request") setPhase({ kind: "error", message: outcome.message, site, existed });
    else setPhase({ kind: "error", message: DOWN, site, existed });
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(serviceAccount);
      setCopied("yes");
    } catch {
      setCopied("failed");
    }
  }

  return (
    <div className="max-w-xl space-y-6">
      <form onSubmit={add} className="space-y-4 rounded-lg border border-hairline bg-bg-panel p-4">
        <div>
          <label htmlFor={`${id}-domain`} className="block text-sm font-medium text-fg">Domain</label>
          <input
            id={`${id}-domain`} name="domain" type="text" inputMode="url" autoComplete="off" spellCheck={false} required
            value={domain} onChange={(e) => setDomain(e.target.value)} disabled={!!site} placeholder="example.com"
            aria-describedby={`${id}-help`}
            aria-invalid={phase.kind === "error" && !site && phase.code === DOMAIN_ERROR_CODE ? true : undefined}
            className="mt-1 h-9 w-full rounded-md border border-bg-border-strong bg-bg px-3 text-sm text-fg placeholder:text-fg-dim focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-60"
          />
          <p id={`${id}-help`} className="mt-1 text-xs text-fg-dim">Just the domain: no https://, no path.</p>
        </div>
        <label className="flex items-start gap-2 text-sm text-fg">
          <input type="checkbox" required checked={dpa} onChange={(e) => setDpa(e.target.checked)} disabled={!!site} className="mt-0.5 h-4 w-4 accent-accent" />
          <span>The client has signed our data processing agreement.</span>
        </label>
        <label className="flex items-start gap-2 text-sm text-fg-muted">
          <input type="checkbox" checked={isTest} onChange={(e) => setIsTest(e.target.checked)} disabled={!!site} className="mt-0.5 h-4 w-4 accent-accent" />
          <span>Test site (hidden from the list unless test sites are shown)</span>
        </label>
        {!site && (
          <button type="submit" disabled={busy} className={BTN}>{phase.kind === "saving" ? "Adding" : "Add site"}</button>
        )}
      </form>

      <section className="space-y-3 rounded-lg border border-hairline bg-bg-panel p-4 text-sm">
        <h2 className="font-semibold text-fg">Ask the client to share Search Console</h2>
        <p className="text-fg-muted">
          In Search Console: Settings, Users and permissions, Add user. Restricted access is enough. The address to add:
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <code className="break-all rounded bg-bg-elev px-2 py-1 text-xs text-fg">{serviceAccount}</code>
          <button type="button" onClick={copy} className={BTN2}>{copied === "yes" ? "Copied" : "Copy"}</button>
          <span aria-live="polite" className="sr-only">
            {copied === "yes" ? "Copied to clipboard." : copied === "failed" ? "Copy failed. Select the address and copy it." : ""}
          </span>
        </div>
        {copied === "failed" && <p className="text-xs text-status-warm">Copy failed: select the address and copy it.</p>}
        {site && (
          <button type="button" onClick={check} disabled={busy} className={BTN}>
            {phase.kind === "checking" ? "Checking" : phase.kind === "access" ? "Check again" : "Check access"}
          </button>
        )}
      </section>

      <div aria-live="polite" className="text-sm">
        {phase.kind === "added" && (
          <p className="text-fg">
            {phase.existed ? "That domain is already added." : `Added ${phase.site.domain}. Waiting for the client.`}{" "}
            <Link prefetch={false} href={`${base}/${phase.site.id}`} className="text-accent hover:underline">Open it</Link>
          </p>
        )}
        {phase.kind === "access" && phase.result.result === "ok" && (
          <p className="text-fg">
            <span aria-hidden className="text-status-engaged">{"●"} </span>
            Access confirmed, collecting. First figures appear after the next pull, within 15 minutes.{" "}
            <Link prefetch={false} href={`${base}/${phase.site.id}`} className="text-accent hover:underline">Open it</Link>
          </p>
        )}
        {phase.kind === "access" && phase.result.result !== "ok" && (
          <div role="alert" className="text-fg">
            <p>
              <span aria-hidden className="text-status-hot">{"■"} </span>
              {phase.result.result === "blocked" ? "Access refused. Google said:" : "Google did not answer usefully. Try again later. Detail:"}
            </p>
            <p className="mt-1 break-words text-xs text-fg-muted">{phase.result.reason}</p>
          </div>
        )}
        {phase.kind === "error" && <p role="alert" className="text-status-warm">{phase.message}</p>}
      </div>
    </div>
  );
}
