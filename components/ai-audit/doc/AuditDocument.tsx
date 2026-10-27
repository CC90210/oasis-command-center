/**
 * The Free AI Audit, drawn from its data (lib/ai-audit/doc.ts AuditDoc +
 * lib/ai-audit/proposal.ts ProposalContent). One component for every place it
 * appears, so the web page and the PDF can never say different things:
 *   mode "web"     the client's private page (app/your-audit/[token])
 *   mode "pdf"     the print view the Mac turns into the PDF (app/audit-print)
 *   mode "preview" CC's view of a draft or a submitted version
 *
 * A server component with no state. Every figure it shows comes from the data;
 * every label is one of the four the brief defines, with a legend at the top.
 * Transcript quotes, line references and internal notes are not in this data
 * at all, so they cannot leak onto the page.
 */
import "./audit-document.css";
import {
  BUSINESS_TYPE_LABELS,
  EVIDENCE_LABELS,
  EVIDENCE_LABEL_MEANINGS,
  EVIDENCE_LABEL_NAMES,
  type EvidenceLabel,
} from "@/lib/ai-audit/rules";
import { SECTION_TITLES, type AuditDoc, type DocEstimate, type DocParagraph, type DocRoadmapItem } from "@/lib/ai-audit/doc";
import { REVENUE_ESTIMATES } from "@/lib/ai-audit/impact";
import { paybackFor, type Payback } from "@/lib/ai-audit/payback";
import { rateText, type ProposalContent, type ProposalLine, type ProposalTotals } from "@/lib/ai-audit/proposal";

export type AuditDocumentProps = {
  doc: AuditDoc;
  proposal: ProposalContent;
  totals: ProposalTotals;
  mode: "web" | "pdf" | "preview";
  /** web: where the Pay form posts. */
  payAction?: string | null;
  /** Why paying is not possible right now (already paid, link expired), shown instead of the button. */
  payUnavailable?: string | null;
  /** web: the stored PDF. */
  pdfHref?: string | null;
  /** A one-line message at the top (a cancelled checkout, a payment being confirmed). */
  notice?: string | null;
};

function money(cents: number, currency: "CAD" | "USD"): string {
  return new Intl.NumberFormat(currency === "USD" ? "en-US" : "en-CA", {
    style: "currency",
    currency,
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
  }).format(cents / 100);
}

/** A figure with its unit as people write it: $450, 50%, 7 calls (the self-test PDF read "450 $" and "50 %"). */
function withUnit(n: number, unit: string | null | undefined): string {
  if (unit === "$") return `$${plainNumber(n)}`;
  if (unit === "%") return `${plainNumber(n)}%`;
  return unit ? `${plainNumber(n)} ${unit}` : plainNumber(n);
}

function plainNumber(n: number): string {
  return new Intl.NumberFormat("en-CA", { maximumFractionDigits: 2 }).format(n);
}

function dateLong(iso: string): string {
  const d = new Date(`${iso.slice(0, 10)}T12:00:00Z`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("en-CA", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
}

function Label({ label }: { label: EvidenceLabel }) {
  return <span className={`aa-label aa-label-${label}`}>{EVIDENCE_LABEL_NAMES[label]}</span>;
}

type Refs = {
  sourceNo: Map<string, number>;
  findingNo: Map<string, number>;
  estimateNo: Map<string, number>;
};

function Cites({ ids: raw, refs }: { ids: string[]; refs: Refs }) {
  // A paragraph and its item may name the same id; show it once.
  const ids = [...new Set(raw)];
  if (!ids.length) return null;
  const sources = ids.filter((i) => refs.sourceNo.has(i)).map((i) => refs.sourceNo.get(i) as number);
  const findings = ids.filter((i) => refs.findingNo.has(i)).map((i) => refs.findingNo.get(i) as number);
  const estimates = ids.filter((i) => refs.estimateNo.has(i)).map((i) => refs.estimateNo.get(i) as number);
  const parts: string[] = [];
  if (sources.length) parts.push(`[${sources.sort((a, b) => a - b).join(", ")}]`);
  if (findings.length) parts.push(`(Finding ${findings.join(", ")})`);
  if (estimates.length) parts.push(`(Estimate ${estimates.join(", ")})`);
  return <span className="aa-cites">{parts.join(" ")}</span>;
}

function Para({ p, refs }: { p: DocParagraph; refs: Refs }) {
  return (
    <p>
      {p.text} <Cites ids={p.cites} refs={refs} />
    </p>
  );
}

/** One line icon per section, drawn inline so the web page and the PDF need nothing fetched. */
const SECTION_ICONS: Record<number, React.ReactNode> = {
  1: <path d="M5 3h10l4 4v14H5zM15 3v4h4M8.5 12h7M8.5 16h5" />,
  2: <path d="M4 20V11M10 20V5M16 20v-6M22 20H2" />,
  3: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m20 20-4.3-4.3" />
    </>
  ),
  4: <path d="M12 3.5 21.5 20h-19zM12 10v4.5M12 17.2v.3" />,
  5: <path d="M12 2.5l2.3 6.2 6.2 2.3-6.2 2.3L12 19.5l-2.3-6.2L3.5 11l6.2-2.3z" />,
  6: <path d="M5 21V4M5 4h12l-2.5 4L17 12H5" />,
  7: <path d="M3 17l6-6 4 4 8-8M15 7h6v6" />,
  8: <path d="M8 4h8v3H8zM6 5.5H4.5V21h15V5.5H18M8 12h8M8 16h5" />,
  9: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M8 12h8m-3.5-3.5L16 12l-3.5 3.5" />
    </>
  ),
};

function SectionIcon({ n }: { n: number }) {
  return (
    <span className="aa-section-icon" aria-hidden="true">
      <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" focusable="false">
        {SECTION_ICONS[n]}
      </svg>
    </span>
  );
}

function Section({ n, id, children }: { n: number; id: string; children: React.ReactNode }) {
  return (
    <section className="aa-section" id={id} aria-labelledby={`${id}-title`}>
      <div className="aa-section-head">
        <SectionIcon n={n} />
        <div>
          <span className="aa-section-no">Section {n}</span>
          <h2 id={`${id}-title`}>{SECTION_TITLES[n - 1]}</h2>
        </div>
      </div>
      {children}
    </section>
  );
}

/**
 * A finding's words under its own title: "Team size: 6 people." drops "Team size: ", and drops entirely when what is
 * left is only the figure the card already shows large.
 */
export function findingWords(f: { title: string; statement: string; metric?: { unit: string } | null }): string | null {
  const said = f.statement.startsWith(`${f.title}: `) ? f.statement.slice(f.title.length + 2) : f.statement;
  if (f.metric && said.replace(f.metric.unit, "").replace(/[\d.,$%\s]/g, "") === "") return null;
  return said ? said.charAt(0).toUpperCase() + said.slice(1) : f.statement;
}

/** "$1,370 to $3,410" for money, "2 to 4.5" otherwise: the range as the reader says it. */
function rangeText(e: DocEstimate): string {
  const u = e.unit === "$" || e.unit === "%" ? e.unit : null;
  return `${withUnit(e.low, u)} to ${withUnit(e.high, u)}`;
}

function rangeTail(e: DocEstimate): string {
  return [e.unit === "$" || e.unit === "%" ? "" : e.unit, e.period].filter(Boolean).join(" ");
}

/**
 * Payback, from the audit's own figures only: the price due now over the monthly money estimate, so "about 3 to 7
 * months" is a calculation the reader can redo, labelled a Reasonable estimate. None when the money estimate is not
 * monthly, a line still needs a price, or nothing is due.
 */
function ValueChart({ p, cur }: { p: Payback; cur: "CAD" | "USD" }) {
  // Twelve months of the estimate's low and high, less any monthly fee, against the full one-time price, on one scale.
  const after = p.monthlyFees > 0 ? " after fees" : "";
  const rows = [
    { label: "Investment, one time", value: p.investment, kind: "price" },
    { label: `Value in 12 months${after}, low`, value: (p.estimate.low - p.monthlyFees) * 12, kind: "low" },
    { label: `Value in 12 months${after}, high`, value: (p.estimate.high - p.monthlyFees) * 12, kind: "high" },
  ];
  const top = Math.max(...rows.map((r) => r.value), 1);
  return (
    <figure className="aa-chart" aria-label="The one-time investment against twelve months of the estimated value">
      {rows.map((r) => (
        <div key={r.kind} className="aa-chart-row">
          <span className="aa-chart-label">{r.label}</span>
          <span className="aa-chart-track">
            <span className={`aa-chart-bar aa-chart-${r.kind}`} style={{ width: `${Math.max(2, (r.value / top) * 100)}%` }} />
          </span>
          <span className="aa-chart-value">{money(Math.round(r.value * 100), cur)}</span>
        </div>
      ))}
      <figcaption className="aa-small">
        <Label label="estimate" /> Twelve times the monthly range in {p.estimate.title.toLowerCase()}{p.monthlyFees > 0 ? ", less the monthly fees" : ""}, beside what the work costs once.
      </figcaption>
    </figure>
  );
}

function RangeBar({ e }: { e: DocEstimate }) {
  const top = Math.max(e.high, 1) * 1.1;
  const x1 = Math.max(0, (e.low / top) * 100);
  const x2 = Math.max(x1 + 1, (e.high / top) * 100);
  return (
    <svg className="aa-range-bar" viewBox="0 0 100 14" preserveAspectRatio="none" role="img" aria-label={`Range from ${plainNumber(e.low)} to ${plainNumber(e.high)} ${e.unit}`}>
      <rect x="0" y="5" width="100" height="4" rx="2" fill="#e2e5ea" />
      <rect x={x1} y="2" width={x2 - x1} height="10" rx="2" fill="#00d4ff" />
    </svg>
  );
}

function lineAmount(l: ProposalLine): number | null {
  return l.kind === "needs_owner_price" ? null : l.unit_price_cents * l.quantity;
}

function RoadmapColumn({ step, title, hint, items, opportunities }: { step: number; title: string; hint: string; items: DocRoadmapItem[]; opportunities: Map<string, string> }) {
  return (
    <div className="aa-roadmap-col">
      <div className="aa-roadmap-step">
        <span className="aa-roadmap-dot">{step}</span>
        <h3>{title}</h3>
      </div>
      <p className="aa-roadmap-hint">{hint}</p>
      {items.length === 0 ? <p className="aa-small">Nothing planned here.</p> : null}
      {items.map((r) => (
        <div key={`${title}-${r.opportunity_id}`} className="aa-roadmap-item">
          <strong>{opportunities.get(r.opportunity_id) ?? r.opportunity_id}</strong>
          <div className="aa-tags">
            <span>Impact: {r.impact}</span>
            <span>Effort: {r.effort}</span>
            {r.urgency ? <span>{r.urgency}</span> : null}
          </div>
          {r.dependencies.length ? <p className="aa-small" style={{ marginTop: 8, marginBottom: 0 }}>Needs first: {r.dependencies.join("; ")}</p> : null}
        </div>
      ))}
    </div>
  );
}

export function AuditDocument({ doc, proposal, totals, mode, payAction, payUnavailable, pdfHref, notice }: AuditDocumentProps) {
  const refs: Refs = {
    sourceNo: new Map(doc.sources.map((s, i) => [s.id, i + 1])),
    // In the order section 3 shows them, then any finding cited elsewhere only: the reader meets F1, F2, F3 in turn.
    findingNo: new Map(
      [...new Set([...doc.sections.key_findings.finding_ids.filter((id) => doc.findings.some((f) => f.id === id)), ...doc.findings.map((f) => f.id)])].map((id, i) => [id, i + 1]),
    ),
    estimateNo: new Map(doc.estimates.map((e, i) => [e.id, i + 1])),
  };
  const findings = new Map(doc.findings.map((f) => [f.id, f]));
  const estimates = new Map(doc.estimates.map((e) => [e.id, e]));
  const opportunityTitles = new Map(doc.sections.opportunities.items.map((o) => [o.id, o.title]));
  const cur = proposal.currency;
  const oneTime = proposal.lines.filter((l) => !l.optional && l.unit !== "per_month");
  const monthly = proposal.lines.filter((l) => !l.optional && l.unit === "per_month");
  const optional = proposal.lines.filter((l) => l.optional);
  const deposit = proposal.payment_terms.kind === "deposit" ? proposal.payment_terms : null;
  // The cover's figures: the largest revenue estimate (else the largest money one, named for what it is), the time
  // estimate, the full price, and payback only where lib/ai-audit/payback.ts can show it.
  const byHigh = [...doc.estimates].filter((e) => e.unit === "$").sort((a, b) => b.high - a.high);
  const topMoney = byHigh.find((e) => REVENUE_ESTIMATES.has(e.id)) ?? byHigh[0];
  const topIsRevenue = !!topMoney && REVENUE_ESTIMATES.has(topMoney.id);
  const topHours = doc.estimates.find((e) => e.unit === "hours");
  const priced = !proposal.lines.some((l) => l.kind === "needs_owner_price") && totals.total_cents > 0;
  const payback = paybackFor(doc, proposal, totals);
  const priceNote = [
    deposit && priced ? `${money(totals.due_now_cents, cur)} to start` : null,
    totals.monthly_cents > 0 ? `plus ${money(totals.monthly_cents, cur)} a month after launch` : null,
    payback ? `pays back in about ${payback.fast} to ${payback.slow} months on Estimate ${refs.estimateNo.get(payback.estimate.id)}` : null,
  ].filter(Boolean).join("; ");
  const moves = (doc.sections.roadmap.now.length ? doc.sections.roadmap.now.map((r) => opportunityTitles.get(r.opportunity_id)) : doc.sections.opportunities.items.map((o) => o.title))
    .filter((x): x is string => !!x)
    .slice(0, 3);
  const roadmapOf = new Map([...doc.sections.roadmap.now, ...doc.sections.roadmap.next, ...doc.sections.roadmap.later].map((r) => [r.opportunity_id, r]));
  // Converted prices (USD core, paid in CAD on request): one plain sentence per rate used, under the price table.
  const conversions = [
    ...new Map(
      proposal.lines.flatMap((l) => (l.kind === "catalogue" && l.fx ? [l.fx] : [])).map((f) => [`${f.from_currency}|${f.rate_ppm}|${f.as_of}`, f] as const),
    ).values(),
  ];

  return (
    <div className="aa" data-audit-ready="1">
      {mode !== "pdf" && pdfHref ? (
        <div className="aa-toolbar aa-screen-only">
          <a href={pdfHref}>Download the PDF</a>
        </div>
      ) : null}
      <article className="aa-paper">
        <header className="aa-cover">
          <div className="aa-cover-top">
            {/* eslint-disable-next-line @next/next/no-img-element -- a plain img prints in the PDF; next/image does not */}
            <img className="aa-cover-logo" src="/oasis-logo.jpg" alt="" width="40" height="60" />
            <div className="aa-brand">
              OASIS AI <span>Solutions</span>
            </div>
          </div>
          <p className="aa-eyebrow">Free AI Audit</p>
          <h1>
            <span className="aa-sr">Free AI Audit for </span>
            {doc.business.name}
          </h1>
          <p className="aa-cover-meta">
            {doc.prepared_for.name ? <>Prepared for {doc.prepared_for.name}. </> : null}
            {dateLong(doc.prepared_on)}.
            {[doc.business.type !== "other" ? BUSINESS_TYPE_LABELS[doc.business.type] : null, doc.business.location || null].filter(Boolean).length
              ? ` ${[doc.business.type !== "other" ? BUSINESS_TYPE_LABELS[doc.business.type] : null, doc.business.location || null].filter(Boolean).join(", ")}.`
              : ""}
          </p>
          {notice ? <p className="aa-notice">{notice}</p> : null}
          <div className="aa-glance">
            {topMoney ? (
              <div className="aa-stat">
                <span className="aa-stat-label">{topIsRevenue ? "Revenue within reach" : topMoney.title}</span>
                <strong>{rangeText(topMoney)}</strong>
                <span className="aa-stat-note">
                  {rangeTail(topMoney)}
                  {topIsRevenue ? `, from ${topMoney.title.toLowerCase()}` : ""} (Estimate {refs.estimateNo.get(topMoney.id)})
                </span>
              </div>
            ) : null}
            {topHours ? (
              <div className="aa-stat">
                <span className="aa-stat-label">Time back</span>
                <strong>{rangeText(topHours)}</strong>
                <span className="aa-stat-note">{rangeTail(topHours)} (Estimate {refs.estimateNo.get(topHours.id)})</span>
              </div>
            ) : null}
            <div className="aa-stat aa-stat-price">
              <span className="aa-stat-label">Investment</span>
              <strong>{priced ? money(totals.total_cents, cur) : "To be priced"}</strong>
              <span className="aa-stat-note">
                {priceNote ? priceNote.charAt(0).toUpperCase() + priceNote.slice(1) : priced ? "Due to start the work" : "We confirm the price with you"}
              </span>
            </div>
          </div>
          {moves.length ? (
            <div className="aa-moves">
              <span className="aa-moves-label">Where we would start</span>
              <ol>
                {moves.map((m, i) => (
                  <li key={i}>{m}</li>
                ))}
              </ol>
            </div>
          ) : null}
          <p className="aa-cover-foot">Prepared by OASIS AI Solutions, oasisai.work. Private to {doc.business.name}; free, with no obligation.</p>
        </header>

        <div className="aa-intro">
          <div className="aa-legend">
            <h3>How to read this audit</h3>
            <p className="aa-small">Every finding carries one of four labels, so you can see how sure we are and why.</p>
            <dl>
              {EVIDENCE_LABELS.map((l) => (
                <div key={l} style={{ display: "contents" }}>
                  <dt>
                    <Label label={l} />
                  </dt>
                  <dd>{EVIDENCE_LABEL_MEANINGS[l]}</dd>
                </div>
              ))}
            </dl>
          </div>
          <ol className="aa-contents">
            {SECTION_TITLES.map((t, i) => (
              <li key={t}>
                <a href={`#s${i + 1}`}>
                  <span className="aa-num">{String(i + 1).padStart(2, "0")}</span>
                  {t}
                </a>
              </li>
            ))}
          </ol>
        </div>

        <Section n={1} id="s1">
          {doc.sections.executive_overview.paragraphs.map((p, i) => (
            <Para key={i} p={p} refs={refs} />
          ))}
        </Section>

        <Section n={2} id="s2">
          {doc.sections.current_assessment.paragraphs.map((p, i) => (
            <Para key={i} p={p} refs={refs} />
          ))}
          {doc.sections.current_assessment.systems.length ? (
            <table className="aa-systems">
              <thead>
                <tr>
                  <th scope="col">System or tool</th>
                  <th scope="col">What it does today</th>
                  <th scope="col">Basis</th>
                </tr>
              </thead>
              <tbody>
                {doc.sections.current_assessment.systems.map((s, i) => (
                  <tr key={`${s.name}-${i}`}>
                    <td>{s.name}</td>
                    <td>
                      {s.role}
                      {s.note ? <div className="aa-small">{s.note}</div> : null}
                    </td>
                    <td>
                      <Label label={s.label} /> <Cites ids={s.cites} refs={refs} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
        </Section>

        <Section n={3} id="s3">
          {doc.sections.key_findings.intro ? <Para p={doc.sections.key_findings.intro} refs={refs} /> : null}
          <ol className="aa-findings aa-grid">
            {doc.sections.key_findings.finding_ids.map((id) => {
              const f = findings.get(id);
              if (!f) return null;
              return (
                <li key={f.id} id={`finding-${f.id}`} className="aa-finding">
                  <div className="aa-finding-top">
                    <div>
                      <h3>
                        <span className="aa-section-no">F{refs.findingNo.get(f.id)}</span> {f.title}
                      </h3>
                      <div style={{ marginTop: 6 }}>
                        <Label label={f.label} /> <Cites ids={f.source_ids} refs={refs} />
                      </div>
                    </div>
                    {f.metric ? (
                      <div className="aa-finding-metric">
                        {f.metric.display ??
                          (f.metric.unit === "$" ? `$${plainNumber(f.metric.value)}` : f.metric.unit === "%" ? `${plainNumber(f.metric.value)}%` : plainNumber(f.metric.value))}
                        <small>{f.metric.display || f.metric.unit === "$" || f.metric.unit === "%" ? "" : f.metric.unit}</small>
                      </div>
                    ) : null}
                  </div>
                  {findingWords(f) ? <p>{findingWords(f)}</p> : null}
                  {f.how_to_test ? <p className="aa-test">How we would check it: {f.how_to_test}</p> : null}
                </li>
              );
            })}
          </ol>
          {doc.gaps.length ? (
            <div className="aa-gaps">
              <h3>What we could not verify</h3>
              <ul>
                {doc.gaps.map((g, i) => (
                  <li key={i}>
                    <strong>{g.topic}.</strong> {g.why}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </Section>

        <Section n={4} id="s4">
          {doc.sections.inefficiencies.items.length === 0 ? (
            // Never a bare heading: the opportunities below still answer what to change.
            <p>We found nothing here that we could confirm beyond the opportunities in the next section.</p>
          ) : null}
          {doc.sections.inefficiencies.items.map((it, i) => (
            <div key={i} className="aa-item aa-item-warn">
              <h3>
                <span className="aa-warn-mark" aria-hidden="true">!</span>
                {it.title}
              </h3>
              <dl className="aa-pairs">
                <dt>Why it matters</dt>
                <dd>
                  {it.why_it_matters.text} <Cites ids={[...it.why_it_matters.cites, ...it.finding_ids]} refs={refs} />
                </dd>
                <dt>If nothing changes</dt>
                <dd>
                  {it.consequence.text} <Cites ids={it.consequence.cites} refs={refs} />
                </dd>
              </dl>
            </div>
          ))}
        </Section>

        <Section n={5} id="s5">
          {doc.sections.opportunities.items.map((o) => (
            <div key={o.id} className="aa-item aa-item-opportunity" id={`opportunity-${o.id}`}>
              <div className="aa-opportunity-head">
                <h3>{o.title}</h3>
                <div className="aa-badges">
                  {roadmapOf.get(o.id) ? (
                    <>
                      <span className={`aa-badge aa-badge-${roadmapOf.get(o.id)!.impact}`}>Impact: {roadmapOf.get(o.id)!.impact}</span>
                      <span className="aa-badge">Effort: {roadmapOf.get(o.id)!.effort}</span>
                    </>
                  ) : null}
                </div>
              </div>
              {o.estimate_ids
                .map((id) => estimates.get(id))
                .filter((e): e is DocEstimate => !!e)
                .slice(0, 1)
                .map((e) => (
                  <p key={e.id} className="aa-callout">
                    <strong>{rangeText(e)}</strong> {rangeTail(e)} <span className="aa-small">(Estimate {refs.estimateNo.get(e.id)})</span>
                  </p>
                ))}
              <dl className="aa-pairs">
                <dt>What it does</dt>
                <dd>{o.what_it_does}</dd>
                <dt>The problem it solves</dt>
                <dd>
                  {o.problem} <Cites ids={o.finding_ids} refs={refs} />
                </dd>
                <dt>How it would work</dt>
                <dd>{o.how_it_works}</dd>
                {o.integrations.length ? (
                  <>
                    <dt>Systems involved</dt>
                    <dd>{o.integrations.map((x, i) => (i > 0 ? x.replace(/^Your /, "your ") : x)).join(", ")}</dd>
                  </>
                ) : null}
                <dt>What could improve</dt>
                <dd>
                  {o.expected_improvement.text} <Cites ids={[...o.expected_improvement.cites, ...o.estimate_ids]} refs={refs} />
                </dd>
              </dl>
              {o.workflow ? (
                <div className="aa-flow" aria-label={`How ${o.title} changes the workflow`}>
                  <div className="aa-flow-col">
                    <h4>Today</h4>
                    <ol>
                      {o.workflow.before.map((s, i) => (
                        <li key={i}>{s}</li>
                      ))}
                    </ol>
                  </div>
                  <div className="aa-flow-arrow" aria-hidden="true">
                    <svg width="22" height="14" viewBox="0 0 22 14" focusable="false">
                      <path d="M1 7h18M13 1l6 6-6 6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </div>
                  <div className="aa-flow-col aa-flow-after">
                    <h4>With the change</h4>
                    <ol>
                      {o.workflow.after.map((s, i) => (
                        <li key={i}>{s}</li>
                      ))}
                    </ol>
                  </div>
                </div>
              ) : null}
            </div>
          ))}
        </Section>

        <Section n={6} id="s6">
          <div className="aa-roadmap">
            <RoadmapColumn step={1} title="Now" hint="Highest impact for the effort; little to set up first." items={doc.sections.roadmap.now} opportunities={opportunityTitles} />
            <RoadmapColumn step={2} title="Next" hint="Builds on the first changes." items={doc.sections.roadmap.next} opportunities={opportunityTitles} />
            <RoadmapColumn step={3} title="Later" hint="Worth it once the basics run." items={doc.sections.roadmap.later} opportunities={opportunityTitles} />
          </div>
        </Section>

        <Section n={7} id="s7">
          {doc.sections.impact.intro ? <Para p={doc.sections.impact.intro} refs={refs} /> : null}
          {doc.sections.impact.estimate_ids.map((id) => {
            const e = estimates.get(id);
            if (!e) return null;
            return (
              <div key={e.id} className="aa-estimate" id={`estimate-${e.id}`}>
                <h3>
                  <span className="aa-section-no">E{refs.estimateNo.get(e.id)}</span> {e.title} <Label label="estimate" />
                </h3>
                <div className="aa-range">
                  <span className="aa-range-value">{rangeText(e)}</span>
                  <span className="aa-small">{rangeTail(e)}</span>
                </div>
                <RangeBar e={e} />
                <p className="aa-small">How it is worked out: {e.formula}.</p>
                <table className="aa-systems">
                  <thead>
                    <tr>
                      <th scope="col">Input</th>
                      <th scope="col" className="aa-money">
                        Value
                      </th>
                      <th scope="col">Basis</th>
                    </tr>
                  </thead>
                  <tbody>
                    {e.inputs.map((inp, i) => (
                      <tr key={i}>
                        <td>{inp.name}</td>
                        <td className="aa-money">
                          {withUnit(inp.value, inp.unit)}
                        </td>
                        <td>
                          <Label label={inp.label} />
                          {inp.basis && refs.sourceNo.has(inp.basis) ? <Cites ids={[inp.basis]} refs={refs} /> : inp.basis ? <span className="aa-small"> {inp.basis}</span> : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {e.assumptions.length ? (
                  <>
                    <p className="aa-small" style={{ marginTop: 12, marginBottom: 4 }}>
                      Assumptions:
                    </p>
                    <ul className="aa-list aa-small">
                      {e.assumptions.map((a, i) => (
                        <li key={i}>{a}</li>
                      ))}
                    </ul>
                  </>
                ) : null}
              </div>
            );
          })}
          {payback ? (
            <div className="aa-estimate aa-payback">
              <h3>
                Value against the investment <Label label="estimate" />
              </h3>
              <ValueChart p={payback} cur={cur} />
              <p className="aa-small">
                How it is worked out: {money(totals.total_cents, cur)}, the full one-time price, divided by the monthly range in Estimate{" "}
                {refs.estimateNo.get(payback.estimate.id)}
                {payback.monthlyFees > 0 ? `, less ${money(totals.monthly_cents, cur)} a month in fees` : ""}. It counts only revenue from work in the price. At the
                high end the work pays for itself in about {payback.fast} {payback.fast === 1 ? "month" : "months"}, at the low end in about {payback.slow}.
              </p>
            </div>
          ) : null}
          {doc.sections.impact.limitations.length ? (
            <div className="aa-limitations">
              <h3>Limits of these estimates</h3>
              <ul className="aa-list">
                {doc.sections.impact.limitations.map((l, i) => (
                  <li key={i}>{l}</li>
                ))}
              </ul>
              <p className="aa-small" style={{ marginTop: 8 }}>
                These are estimates, not promises. Real results depend on how the changes are used.
              </p>
            </div>
          ) : null}
        </Section>

        <Section n={8} id="s8">
          <div className="aa-packages">
            {oneTime.map((l, i) => (
              <div key={l.line_id} className={`aa-package${i === 0 ? " aa-package-first" : ""}`}>
                <div className="aa-package-head">
                  <div>
                    {i === 0 ? <span className="aa-package-tag">Start here</span> : null}
                    <h3>{l.name}</h3>
                  </div>
                  <strong className="aa-package-price">{lineAmount(l) === null ? "To be priced" : money(lineAmount(l) as number, cur)}</strong>
                </div>
                {l.description ? <p className="aa-small">{l.description}</p> : null}
                {l.deliverables.length ? (
                  <ul className="aa-checks">
                    {l.deliverables.map((d, j) => (
                      <li key={j}>{d}</li>
                    ))}
                  </ul>
                ) : null}
                {l.quantity !== 1 ? (
                  <p className="aa-small">
                    {l.quantity} at {l.kind === "needs_owner_price" ? "a price to confirm" : money(l.unit_price_cents, cur)} each
                  </p>
                ) : null}
              </div>
            ))}
          </div>
          <div className="aa-totals">
            <div className="aa-totals-row">
              <span>Subtotal</span>
              <span className="aa-money">{money(totals.subtotal_cents, cur)}</span>
            </div>
            {proposal.tax && proposal.tax.mode === "registered" ? (
              <div className="aa-totals-row">
                <span>
                  {proposal.tax.label} ({plainNumber(proposal.tax.rate_bps / 100)}%){proposal.tax.number ? `, registration ${proposal.tax.number}` : ""}
                </span>
                <span className="aa-money">{money(totals.tax_cents, cur)}</span>
              </div>
            ) : null}
            <div className="aa-totals-row aa-total-row">
              <span>Total ({cur})</span>
              <span className="aa-money">{money(totals.total_cents, cur)}</span>
            </div>
          </div>
          {conversions.map((f) => (
            <p key={`${f.from_currency}${f.rate_ppm}${f.as_of}`} className="aa-small" style={{ marginTop: 8 }}>
              Prices are in {cur}, converted from our {f.from_currency} prices at 1 USD = {rateText(f.rate_ppm)} CAD, the rate of {dateLong(f.as_of)}.
            </p>
          ))}
          {monthly.length ? (
            <>
              <h3 style={{ marginTop: 24 }}>Ongoing costs, after launch</h3>
              <ul className="aa-list">
                {monthly.map((l) => (
                  <li key={l.line_id}>
                    {l.name}: {lineAmount(l) === null ? "to be priced" : `${money(lineAmount(l) as number, cur)} a month`}
                  </li>
                ))}
              </ul>
              <p className="aa-small">Monthly costs start once the work is live. They are not part of the total above.</p>
            </>
          ) : null}
          {optional.length ? (
            <>
              <h3 style={{ marginTop: 24 }}>Optional additions</h3>
              <ul className="aa-list">
                {optional.map((l) => (
                  <li key={l.line_id}>
                    {l.name}: {lineAmount(l) === null ? "to be priced" : `${money(lineAmount(l) as number, cur)}${l.unit === "per_month" ? " a month" : ""}`}. {l.description}
                  </li>
                ))}
              </ul>
              <p className="aa-small">Not included in the total. Ask if you would like any of them.</p>
            </>
          ) : null}
          {proposal.phases.length ? (
            <>
              <h3 style={{ marginTop: 24 }}>Phases</h3>
              <ol className="aa-list">
                {proposal.phases.map((p, i) => (
                  <li key={i}>
                    <strong>{p.name}.</strong> {p.description}
                  </li>
                ))}
              </ol>
            </>
          ) : null}
          <h3 style={{ marginTop: 24 }}>Payment terms</h3>
          <p>
            {deposit
              ? `A ${plainNumber(deposit.deposit_bps / 100)}% deposit (${money(totals.due_now_cents, cur)}) starts the work. The balance is due ${deposit.balance_due}.`
              : `The full amount (${money(totals.due_now_cents, cur)}) is due to start the work.`}
          </p>
          {proposal.exclusions.length ? (
            <>
              <h3 style={{ marginTop: 18 }}>Not included</h3>
              <ul className="aa-list">
                {proposal.exclusions.map((x, i) => (
                  <li key={i}>{x}</li>
                ))}
              </ul>
            </>
          ) : null}
          {proposal.terms.length ? (
            <>
              <h3 style={{ marginTop: 18 }}>Terms</h3>
              <ul className="aa-list">
                {proposal.terms.map((x, i) => (
                  <li key={i}>{x}</li>
                ))}
              </ul>
            </>
          ) : null}
          <p className="aa-small" style={{ marginTop: 14 }}>
            This proposal is valid until {dateLong(proposal.valid_until)}.
          </p>
        </Section>

        <Section n={9} id="s9">
          <div className="aa-due">
            <span>Due to start</span>
            <strong>{money(totals.due_now_cents, cur)}</strong>
          </div>
          <div className="aa-pay">
            {mode === "pdf" ? (
              <p>To accept, open the private page from our email and choose Pay. The page and its payment link are private to you.</p>
            ) : mode === "preview" ? (
              <p className="aa-small">Preview: the client sees a Pay button here, which opens Stripe&apos;s secure checkout for exactly the amount above.</p>
            ) : payUnavailable ? (
              <p>{payUnavailable}</p>
            ) : payAction ? (
              <form method="post" action={payAction}>
                <button type="submit" className="aa-pay-button">
                  Pay {money(totals.due_now_cents, cur)} securely with Stripe
                </button>
                <p className="aa-small" style={{ marginTop: 12, marginBottom: 0 }}>
                  You will go to Stripe&apos;s checkout. We count a payment only once Stripe confirms it, then we follow up with the next steps.
                </p>
              </form>
            ) : null}
          </div>
          {mode !== "preview" ? (
            <p className="aa-ask">
              Questions before you decide? Reply to the email this came with, or{" "}
              <a href="https://oasisai.work/book">book a time to talk</a>
              {mode === "pdf" ? " at oasisai.work/book" : ""}.
            </p>
          ) : null}
          {doc.sections.next_steps.steps.length ? (
            <>
              <h3 style={{ marginTop: 24 }}>What happens next</h3>
              <ol className="aa-steps">
                {doc.sections.next_steps.steps.map((s, i) => (
                  <li key={i}>
                    <span className="aa-step-no">{i + 1}</span>
                    <span>{s}</span>
                  </li>
                ))}
              </ol>
            </>
          ) : null}
        </Section>

        {doc.sources.length ? (
          <section className="aa-section" id="sources" aria-labelledby="sources-title">
            <h2 id="sources-title">Sources</h2>
            <ol className="aa-sources">
              {doc.sources.map((s) => (
                <li key={s.id} id={`src-${refs.sourceNo.get(s.id)}`}>
                  {s.title}
                  {s.publisher ? `, ${s.publisher}` : ""}
                  {s.url ? (
                    <>
                      {". "}
                      {mode === "pdf" ? s.url : <a href={s.url} rel="noopener noreferrer nofollow" target="_blank">{s.url}</a>}
                    </>
                  ) : null}
                  {s.retrieved_at ? `. Checked ${dateLong(s.retrieved_at)}` : ""}
                  {s.kind === "client" ? ". From our conversation with you" : ""}
                  {s.note ? `. ${s.note}` : ""}.
                </li>
              ))}
            </ol>
          </section>
        ) : null}

        <footer className="aa-footer">
          OASIS AI Solutions. This audit was prepared for {doc.business.name} and is private to you. It is free and carries no obligation.
        </footer>
      </article>
    </div>
  );
}
