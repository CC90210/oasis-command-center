"use client";

import { CHECK_TITLES } from "@/lib/ai-audit/site-checks";
import { automationWords } from "@/lib/site-scan/narrative";
import type { ScanView } from "@/lib/site-scan/types";

/**
 * The report body. Each section renders only once its data exists, so the page fills in the
 * order the work happens: health, what you sell, who buys it, prospects, the email, the score.
 */

function Panel({ eyebrow, title, children, tone = "default" }: { eyebrow: string; title: string; children: React.ReactNode; tone?: "default" | "live" }) {
  return (
    <section className={`m-reveal border bg-ops-panel/90 p-6 sm:p-8 ${tone === "live" ? "border-signal/40" : "border-ops-edge"}`}>
      <p className="font-data text-[10px] uppercase tracking-[0.24em] text-signal">{eyebrow}</p>
      <h2 className="mt-3 font-display text-xl font-semibold text-fg sm:text-2xl">{title}</h2>
      <div className="mt-5">{children}</div>
    </section>
  );
}

function Working({ what }: { what: string }) {
  return (
    <p className="m-reveal flex items-center gap-3 border border-dashed border-ops-edge bg-ops-panel/40 px-6 py-5 font-data text-[11px] uppercase tracking-[0.22em] text-fg-dim">
      <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-signal" aria-hidden="true" />
      {what}
    </p>
  );
}

/** A measured distance as a reader says it: "350 m", "3.2 km", "41 km". */
function km(d: number): string {
  if (d < 1) return `${Math.max(10, Math.round((d * 1000) / 10) * 10)} m`;
  return d < 10 ? `${d.toFixed(1)} km` : `${Math.round(d)} km`;
}

/** Where the matches came from, with the attribution each source's licence asks for. */
function sourcesLine(sources: { label: string; note: string }[] | undefined): string {
  if (!sources?.length) return "From OASIS’s own business directory.";
  return `From ${sources.map((s) => s.label).join(" and ")}. ${sources.map((s) => s.note).join(" ")}`;
}

function statusTone(status: "yes" | "no" | "unknown") {
  return status === "yes" ? "bg-status-engaged" : status === "no" ? "bg-status-warm" : "bg-ops-edge";
}

function Ring({ value }: { value: number }) {
  const r = 52;
  const c = 2 * Math.PI * r;
  const dash = (Math.max(0, Math.min(100, value)) / 100) * c;
  const color = value >= 70 ? "var(--status-engaged, #22c55e)" : value >= 45 ? "#E3C567" : "var(--status-warm, #f97316)";
  return (
    <div className="relative h-32 w-32 shrink-0">
      <svg viewBox="0 0 120 120" className="h-32 w-32 -rotate-90">
        <circle cx="60" cy="60" r={r} fill="none" stroke="currentColor" strokeWidth="8" className="text-ops-line" />
        <circle cx="60" cy="60" r={r} fill="none" stroke={color} strokeWidth="8" strokeLinecap="round" strokeDasharray={`${dash} ${c - dash}`} />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="font-display text-4xl font-bold text-fg">{value}</span>
        <span className="font-data text-[9px] uppercase tracking-[0.2em] text-fg-dim">of 100</span>
      </div>
    </div>
  );
}

export function ScanReport({ scan }: { scan: ScanView }) {
  const f = scan.facts;
  const s = f?.signals ?? null;
  const ps = f?.pagespeed && "scores" in f.pagespeed ? f.pagespeed : null;
  const stage = (k: ScanView["stages"][number]["key"]) => scan.stages.find((x) => x.key === k)?.state ?? "pending";
  const name = s?.business_name ?? scan.domain;

  return (
    <div className="space-y-6">
      <header>
        <p className="font-data text-[11px] uppercase tracking-[0.24em] text-fg-dim">Free AI scan · {scan.domain}</p>
        <h1 className="mt-2 font-display text-[clamp(1.8rem,4.5vw,3rem)] font-bold leading-tight tracking-tight text-fg">{name}</h1>
        {s?.tagline ? <p className="mt-2 text-[16px] text-fg-muted">&ldquo;{s.tagline}&rdquo;</p> : null}
      </header>

      {scan.error ? (
        <section className="border border-status-warm/40 bg-ops-panel p-6">
          <p className="font-data text-[10px] uppercase tracking-[0.24em] text-status-warm">Could not finish</p>
          <p className="mt-3 text-[15px] text-fg-muted">{scan.error}</p>
        </section>
      ) : null}

      {!f ? <Working what="Reading the site, page by page" /> : null}

      {f ? (
        <Panel eyebrow="Site health" title={f.site.unread ? "The site could not be read" : `${f.site.pages_read} page${f.site.pages_read === 1 ? "" : "s"} read, ${f.checks.length} checks run`}>
          {f.site.unread ? (
            <p className="text-[15px] text-fg-muted">{f.site.notes[0] ?? "No page answered as the business's own website."}</p>
          ) : (
            <>
              {ps ? (
                <dl className="mb-5 grid grid-cols-2 gap-px overflow-hidden border border-ops-line bg-ops-line sm:grid-cols-4">
                  {([["Mobile speed", ps.scores.performance], ["SEO", ps.scores.seo], ["Accessibility", ps.scores.accessibility], ["Best practices", ps.scores.best_practices]] as const).map(([label, v]) => (
                    <div key={label} className="bg-ops-panel p-4">
                      <dt className="font-data text-[10px] uppercase tracking-[0.2em] text-fg-dim">{label}</dt>
                      <dd className={`mt-1 font-display text-2xl font-semibold ${v === null ? "text-fg-dim" : v >= 90 ? "text-status-engaged" : v >= 50 ? "text-fg" : "text-status-warm"}`}>{v === null ? "–" : v}</dd>
                    </div>
                  ))}
                </dl>
              ) : stage("health") === "done" ? (
                <p className="mb-5 text-[13px] text-fg-dim">Google PageSpeed did not answer in time; speed is judged from the server response below.</p>
              ) : null}
              <ul className="grid gap-2 sm:grid-cols-2">
                {f.checks.map((c) => (
                  <li key={c.key} className="flex gap-3 border border-ops-line bg-ops-void/40 p-3">
                    <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${statusTone(c.status)}`} aria-hidden="true" />
                    <div>
                      <p className="text-[14px] font-medium text-fg">{CHECK_TITLES[c.key]}</p>
                      <p className="mt-0.5 text-[13px] leading-snug text-fg-muted">{c.detail}</p>
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}
        </Panel>
      ) : null}

      {f && !f.site.unread ? (
        stage("profile") === "running" && !scan.narrative ? (
          <Working what="Learning what you sell" />
        ) : scan.narrative ? (
          <Panel eyebrow="What you sell" title={scan.enrich?.category ? scan.enrich.category.label : "What the site says"} tone={stage("profile") === "running" ? "live" : "default"}>
            <p className="text-[15px] leading-relaxed text-fg-muted">{scan.narrative.what_you_sell}</p>
            {s && s.services.length ? (
              <ul className="mt-4 flex flex-wrap gap-2">
                {s.services.map((x) => (
                  <li key={x} className="border border-ops-edge px-2.5 py-1 text-[12px] text-fg">{x}</li>
                ))}
              </ul>
            ) : null}
            {scan.enrich && scan.enrich.keywords.length ? <p className="mt-4 font-data text-[11px] uppercase tracking-[0.18em] text-fg-dim">{scan.enrich.keywords.slice(0, 8).join(" · ")}</p> : null}
            {scan.enrich && scan.enrich.competitors.length ? (
              <div className="mt-6">
                <p className="font-data text-[10px] uppercase tracking-[0.22em] text-fg-dim">Businesses competing for the same searches</p>
                <ul className="mt-3 grid gap-2 sm:grid-cols-2">
                  {scan.enrich.competitors.map((c) => (
                    <li key={`${c.name}-${c.domain}`} className="flex items-center gap-3 border border-ops-line p-3">
                      {c.domain ? <img src={`https://www.google.com/s2/favicons?domain=${encodeURIComponent(c.domain)}&sz=32`} alt="" width={16} height={16} className="h-4 w-4 shrink-0" loading="lazy" /> : <span className="h-4 w-4 shrink-0 bg-ops-edge" aria-hidden="true" />}
                      <span className="min-w-0 flex-1 truncate text-[14px] text-fg">{c.name}</span>
                      {typeof c.distance_km === "number" ? (
                        <span className="shrink-0 text-[12px] tabular-nums text-fg-dim">{km(c.distance_km)} away</span>
                      ) : c.locality ? (
                        <span className="text-[12px] text-fg-dim">{c.locality}</span>
                      ) : null}
                    </li>
                  ))}
                </ul>
                {scan.narrative.competitors_note ? <p className="mt-3 text-[13px] text-fg-muted">{scan.narrative.competitors_note}</p> : null}
              </div>
            ) : null}
          </Panel>
        ) : null
      ) : null}

      {f && !f.site.unread ? (
        stage("segments") === "running" ? (
          <Working what="Working out who buys it" />
        ) : scan.enrich && scan.enrich.segments.length ? (
          <Panel eyebrow="Who buys it" title="Buyer segments, scored for fit">
            <p className="text-[15px] leading-relaxed text-fg-muted">{scan.narrative?.who_buys}</p>
            <table className="mt-5 w-full border-collapse text-left">
              <thead>
                <tr className="font-data text-[10px] uppercase tracking-[0.2em] text-fg-dim">
                  <th className="pb-2 font-normal">Segment</th>
                  <th className="pb-2 text-right font-normal">Fit</th>
                </tr>
              </thead>
              <tbody>
                {scan.enrich.segments.map((seg) => (
                  <tr key={seg.key} className="border-t border-ops-line">
                    <td className="py-3 pr-4">
                      <p className="text-[15px] text-fg">{seg.label}</p>
                      <p className="text-[13px] text-fg-muted">{seg.why}</p>
                    </td>
                    <td className="py-3 text-right align-top">
                      <span className="font-display text-xl font-semibold text-fg">{seg.fit}%</span>
                      <div className="mt-1 ml-auto h-1 w-24 bg-ops-line">
                        <div className="h-1 bg-signal" style={{ width: `${seg.fit}%` }} />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        ) : stage("segments") === "skipped" && scan.narrative ? (
          <Panel eyebrow="Who buys it" title="From the site's own pages">
            <p className="text-[15px] leading-relaxed text-fg-muted">{scan.narrative.who_buys}</p>
          </Panel>
        ) : null
      ) : null}

      {f && !f.site.unread ? (
        stage("prospects") === "running" ? (
          <Working what="Finding businesses like your buyers in our dataset" />
        ) : scan.enrich && scan.enrich.prospects.length ? (
          <Panel eyebrow="Sample prospects" title={`${scan.enrich.prospects.length} real businesses that fit`}>
            <ul className="grid gap-3 sm:grid-cols-2">
              {scan.enrich.prospects.map((p) => (
                <li key={`${p.name}-${p.domain}`} className="border border-ops-line p-4">
                  <p className="text-[15px] font-medium text-fg">{p.name}</p>
                  <p className="mt-0.5 font-data text-[11px] uppercase tracking-[0.16em] text-fg-dim">
                    {p.category_label}
                    {p.locality ? ` · ${p.locality}` : ""}
                    {p.region ? `, ${p.region}` : ""}
                    {typeof p.distance_km === "number" ? ` · ${km(p.distance_km)}` : ""}
                  </p>
                  <p className="mt-2 text-[13px] leading-snug text-fg-muted">{p.why}</p>
                </li>
              ))}
            </ul>
            <p className="mt-4 text-[12px] text-fg-dim">{sourcesLine(scan.enrich.sources)} Names and places only; nobody is contacted by this page.</p>
          </Panel>
        ) : stage("prospects") === "skipped" ? (
          <Panel eyebrow="Sample prospects" title="Found on the call">
            <p className="text-[15px] leading-relaxed text-fg-muted">No close match near you in our business map or directory yet. On the call we pull them live.</p>
          </Panel>
        ) : null
      ) : null}

      {f && !f.site.unread ? (
        stage("email") === "running" ? (
          <Working what="Writing a first email" />
        ) : scan.narrative?.email ? (
          <Panel eyebrow="A first email" title="Written for one of them, from your site's own words">
            <div className="border border-ops-line bg-ops-void/40 p-5 font-mono text-[13px] leading-relaxed text-fg">
              {scan.narrative.email.to ? <p className="text-fg-dim">To: {scan.narrative.email.to}</p> : null}
              <p className="text-fg-dim">Subject: <span className="text-fg">{scan.narrative.email.subject}</span></p>
              <pre className="mt-3 whitespace-pre-wrap font-mono">{scan.narrative.email.body}</pre>
            </div>
          </Panel>
        ) : null
      ) : null}

      {scan.score ? (
        <Panel eyebrow="OASIS score" title={scan.score.total === null ? "Not enough to score" : `${scan.score.total} out of 100`}>
          <div className="flex flex-col gap-6 sm:flex-row sm:items-start">
            {scan.score.total !== null ? <Ring value={scan.score.total} /> : null}
            <div className="min-w-0 flex-1">
              <ul className="space-y-2">
                {scan.score.pillars.map((p) => (
                  <li key={p.key}>
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="text-[14px] text-fg">{p.label}</span>
                      <span className="font-data text-[12px] text-fg-dim">{p.score ?? "n/a"} · {p.weight}% of total</span>
                    </div>
                    <div className="mt-1 h-1 bg-ops-line">
                      {p.score !== null ? (
                        <div className={`h-1 ${p.score >= 70 ? "bg-status-engaged" : p.score >= 45 ? "bg-[#E3C567]" : "bg-status-warm"}`} style={{ width: `${p.score}%` }} />
                      ) : null}
                    </div>
                    <p className="mt-1 text-[12px] text-fg-dim">{p.detail}</p>
                  </li>
                ))}
              </ul>
            </div>
          </div>
          {scan.narrative ? <p className="mt-6 text-[15px] leading-relaxed text-fg-muted">{scan.narrative.fixes_intro}</p> : null}
          {scan.score.fixes.length ? <ol className="mt-5 grid gap-px overflow-hidden border border-ops-line bg-ops-line md:grid-cols-3">
            {scan.score.fixes.map((fix, i) => (
              <li key={fix.key} className="bg-ops-panel p-5">
                <p className="font-data text-[10px] uppercase tracking-[0.22em] text-fg-dim">Fix {i + 1} · +{fix.impact} pts</p>
                <p className="mt-2 text-[15px] font-semibold text-fg">{fix.title}</p>
                <p className="mt-1 text-[13px] leading-snug text-fg-muted">{fix.why}</p>
                <p className="mt-3 text-[12px] text-signal">OASIS builds: {automationWords(fix.automation)}</p>
              </li>
            ))}
          </ol> : null}
        </Panel>
      ) : f && !scan.error ? (
        <Working what="Scoring and prioritising fixes" />
      ) : null}
    </div>
  );
}
