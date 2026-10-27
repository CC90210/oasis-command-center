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

function Section({ n, id, children }: { n: number; id: string; children: React.ReactNode }) {
  return (
    <section className="aa-section" id={id} aria-labelledby={`${id}-title`}>
      <div className="aa-section-head">
        <span className="aa-section-no">{String(n).padStart(2, "0")}</span>
        <h2 id={`${id}-title`}>{SECTION_TITLES[n - 1]}</h2>
      </div>
      {children}
    </section>
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

function RoadmapColumn({ title, hint, items, opportunities }: { title: string; hint: string; items: DocRoadmapItem[]; opportunities: Map<string, string> }) {
  return (
    <div className="aa-roadmap-col">
      <h3>{title}</h3>
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
  // Converted prices (USD core, paid in CAD on request): one plain sentence per rate used, under the price table.
  const conversions = [
    ...new Map(
      proposal.lines.flatMap((l) => (l.kind === "catalogue" && l.fx ? [l.fx] : [])).map((f) => [`${f.from_currency}|${f.rate_ppm}|${f.as_of}`, f] as const),
    ).values(),
  ];

  return (
    <div className="aa" data-audit-ready="1">
      {mode === "web" && pdfHref ? (
        <div className="aa-toolbar aa-screen-only">
          <a href={pdfHref}>Download the PDF</a>
        </div>
      ) : null}
      <article className="aa-paper">
        <header>
          <div className="aa-brand">
            OASIS AI <span>Solutions</span>
          </div>
          <h1>Free AI Audit for {doc.business.name}</h1>
          <p className="aa-cover-meta">
            {doc.prepared_for.name ? <>Prepared for {doc.prepared_for.name}. </> : null}
            {dateLong(doc.prepared_on)}.
            {[doc.business.type !== "other" ? BUSINESS_TYPE_LABELS[doc.business.type] : null, doc.business.location || null].filter(Boolean).length
              ? ` ${[doc.business.type !== "other" ? BUSINESS_TYPE_LABELS[doc.business.type] : null, doc.business.location || null].filter(Boolean).join(", ")}.`
              : ""}
          </p>
          {notice ? <p className="aa-notice">{notice}</p> : null}
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
        </header>

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
          <ol className="aa-findings">
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
                  <p>{f.statement}</p>
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
          {doc.sections.inefficiencies.items.map((it, i) => (
            <div key={i} className="aa-item">
              <h3>{it.title}</h3>
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
            <div key={o.id} className="aa-item" id={`opportunity-${o.id}`}>
              <h3>{o.title}</h3>
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
            <RoadmapColumn title="Now" hint="Highest impact for the effort; little to set up first." items={doc.sections.roadmap.now} opportunities={opportunityTitles} />
            <RoadmapColumn title="Next" hint="Builds on the first changes." items={doc.sections.roadmap.next} opportunities={opportunityTitles} />
            <RoadmapColumn title="Later" hint="Worth it once the basics run." items={doc.sections.roadmap.later} opportunities={opportunityTitles} />
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
                  <span className="aa-range-value">
                    {withUnit(e.low, e.unit === "$" || e.unit === "%" ? e.unit : null)} to {withUnit(e.high, e.unit === "$" || e.unit === "%" ? e.unit : null)}
                  </span>
                  <span className="aa-small">{[e.unit === "$" || e.unit === "%" ? "" : e.unit, e.period].filter(Boolean).join(" ")}</span>
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
          <table className="aa-proposal-table">
            <thead>
              <tr>
                <th scope="col">What we would deliver</th>
                <th scope="col" className="aa-money">
                  Quantity
                </th>
                <th scope="col" className="aa-money">
                  Unit price
                </th>
                <th scope="col" className="aa-money">
                  Amount
                </th>
              </tr>
            </thead>
            <tbody>
              {oneTime.map((l) => (
                <tr key={l.line_id}>
                  <td>
                    <strong>{l.name}</strong>
                    {l.description ? <div className="aa-small">{l.description}</div> : null}
                    {l.deliverables.length ? (
                      <ul className="aa-list aa-small" style={{ marginTop: 6 }}>
                        {l.deliverables.map((d, i) => (
                          <li key={i}>{d}</li>
                        ))}
                      </ul>
                    ) : null}
                  </td>
                  <td className="aa-money">{l.quantity}</td>
                  <td className="aa-money">{l.kind === "needs_owner_price" ? "To be priced" : money(l.unit_price_cents, cur)}</td>
                  <td className="aa-money">{lineAmount(l) === null ? "To be priced" : money(lineAmount(l) as number, cur)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={3}>Subtotal</td>
                <td className="aa-money">{money(totals.subtotal_cents, cur)}</td>
              </tr>
              {proposal.tax && proposal.tax.mode === "registered" ? (
                <tr>
                  <td colSpan={3}>
                    {proposal.tax.label} ({plainNumber(proposal.tax.rate_bps / 100)}%){proposal.tax.number ? `, registration ${proposal.tax.number}` : ""}
                  </td>
                  <td className="aa-money">{money(totals.tax_cents, cur)}</td>
                </tr>
              ) : null}
              <tr className="aa-total-row">
                <td colSpan={3}>Total ({cur})</td>
                <td className="aa-money">{money(totals.total_cents, cur)}</td>
              </tr>
            </tfoot>
          </table>
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
              <ol className="aa-list">
                {doc.sections.next_steps.steps.map((s, i) => (
                  <li key={i}>{s}</li>
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
