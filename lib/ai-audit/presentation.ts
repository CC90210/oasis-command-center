/** Presentation data: measured signals and catalogue-backed discussion options. */
import type { PreCallBrief } from "@/lib/ai-audit/brief";
import type { CatalogueItem } from "@/lib/ai-audit/catalogue";
import type { BusinessType } from "@/lib/ai-audit/rules";

export function meetingTime(iso: string | null): string {
  if (!iso || !Number.isFinite(Date.parse(iso))) return "Time not available";
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Toronto", weekday: "short", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit", timeZoneName: "short",
  }).format(new Date(iso));
}

export function diagnosticSignals(brief: PreCallBrief | null): Array<{ text: string; basis: string }> {
  if (!brief) return [];
  const signals: Array<{ text: string; basis: string }> = [];
  const ps = brief.diagnostics?.pagespeed;
  if (ps?.ok && ps.scores.performance !== null) signals.push({
    text: `Mobile performance: ${ps.scores.performance}/100${ps.timings.lcp_ms !== null ? `; largest content appears in ${(ps.timings.lcp_ms / 1000).toFixed(1)}s` : ""}.`,
    basis: "Google Lighthouse lab measurement; actual visitor experience varies.",
  });
  const checks = brief.diagnostics?.checks ?? [];
  for (const key of ["online_booking", "contact_form", "mobile_viewport", "https", "title", "meta_description", "response_time"] as const) {
    const check = checks.find(c => c.key === key && c.status === "no");
    if (check) signals.push({ text: check.detail, basis: `Website pages checked ${new Date(brief.built_at).toLocaleDateString("en-CA", { timeZone: "America/Toronto" })}.` });
  }
  if (!signals.length) for (const fact of brief.facts.filter(f => f.source.kind === "site")) {
    signals.push({ text: fact.statement, basis: "Observed on the pages checked." });
  }
  return signals.slice(0, 4);
}

export type PresentationOption = { id: string; title: string; question: string; item: CatalogueItem | null };
export function presentationOptions(brief: PreCallBrief | null, businessType: BusinessType | null, catalogue: CatalogueItem[]): PresentationOption[] {
  if (!brief) return [];
  const hypotheses = new Set(brief.hypotheses.map(h => h.id));
  const picks: Array<{ id: string; title: string; question: string; sku: string }> = [];
  if (["booking-by-hand", "chat-without-booking", "no-way-to-ask"].some(id => hypotheses.has(id))) picks.push({
    id: "capture-and-book", title: "Capture enquiries and book online",
    question: "Confirm how bookings and enquiries are handled today, including after hours.", sku: "checkout-conversion-sprint-focused",
  });
  if (["phone-unfriendly", "not-secure", "unmeasured-visitors"].some(id => hypotheses.has(id)) ||
      (brief.diagnostics?.pagespeed?.ok && (brief.diagnostics.pagespeed.scores.performance ?? 100) < 50)) picks.push({
    id: "website-foundation", title: "Improve the website's conversion foundations",
    question: "Confirm the priority: mobile usability, site speed, security or measurement.", sku: "checkout-conversion-sprint-focused",
  });
  if (hypotheses.has("no-own-site")) picks.push({
    id: "own-site", title: "Create a website the business controls",
    question: "Confirm whether the business already has a website at another address.", sku: "website-starter",
  });
  if (businessType === "local_service" || businessType === "professional_services") picks.push({
    id: "after-hours", title: "Explore an after-hours booking assistant",
    question: "Is there a gap in response times or missed calls? This is a discussion option, not a measured finding.", sku: "checkout-sales-setter-launch",
  });
  if (businessType && businessType !== "individual_productivity") picks.push({
    id: "connected-tools", title: "Explore CRM sync and less manual entry",
    question: "Which details are copied between tools, and how often? Confirm a bottleneck before proposing an integration.", sku: "fleet-custom-integration",
  });
  // Several findings can point to one service; show its price once.
  const unique = new Map<string, (typeof picks)[number]>();
  for (const pick of picks) {
    const prior = unique.get(pick.sku);
    if (prior) unique.set(pick.sku, { ...prior, title: "Website conversion and online booking", question: `${prior.question} ${pick.question}` });
    else unique.set(pick.sku, pick);
  }
  return [...unique.values()].slice(0, 4).map(({ sku, ...pick }) => ({
    ...pick, item: catalogue.find(i => i.sku === sku && i.status === "confirmed" && i.price_cents !== null) ?? null,
  }));
}
