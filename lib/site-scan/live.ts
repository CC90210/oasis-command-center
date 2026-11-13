/**
 * lib/site-scan/live.ts — the feed's lines for Tier 0, from what the read actually returned.
 *
 * Pure: each function turns one real result (a request, the pages chosen, the checks, PageSpeed,
 * the signals, the score) into lines for lib/site-scan/events.ts. A line states only what its
 * input holds; a step that found nothing says so plainly.
 */
import { CHECK_TITLES, decodeEntities, type CheckKey, type LinkedPage, type SiteCheck } from "@/lib/ai-audit/site-checks";
import type { PageRecord } from "@/lib/ai-audit/site-fetch";
import type { PageSpeedResult } from "@/lib/ai-audit/pagespeed";
import type { ScanScore, SiteSignals } from "@/lib/site-scan/types";
import type { ScanEventKind } from "@/lib/site-scan/events";

export type Line = { kind: ScanEventKind; text: string; data?: Record<string, unknown> };

function pathOf(url: string): string {
  try {
    const u = new URL(url);
    const p = `${u.pathname}${u.search}`;
    return p.length > 60 ? `${p.slice(0, 57)}...` : p || "/";
  } catch {
    return url.slice(0, 60);
  }
}

function seconds(ms: number): string {
  return ms >= 1_000 ? `${(ms / 1_000).toFixed(1)} s` : `${ms} ms`;
}

/** Why a request failed, in a few words (lib/ai-audit/site-fetch.ts read errors). */
function shortError(error: string): string {
  if (/^robots_/.test(error)) return "robots.txt asks crawlers not to";
  if (/^timed_out/.test(error)) return "it did not answer in time";
  if (/^unreachable/.test(error)) return "it could not be reached";
  if (/redirect/.test(error)) return "it redirected too many times";
  if (/too_large|size/.test(error)) return "it was too large";
  return "it could not be read";
}

/** A page title for one line: entities decoded, cut at a word with an ellipsis, never mid-word. */
export function shortTitle(title: string, max = 70): string {
  const t = decodeEntities(title).replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s|,;:-]+$/, "")}...`;
}

export function pageLine(rec: PageRecord): Line {
  const path = pathOf(rec.url);
  const base = { kind: rec.kind, path, status: rec.status, ms: rec.ms };
  if (rec.error !== null) {
    if (rec.kind === "robots_txt") return { kind: "page", text: `robots.txt did not answer: ${shortError(rec.error)}`, data: base };
    return { kind: "page", text: `Could not open ${path}: ${shortError(rec.error)}`, data: base };
  }
  switch (rec.kind) {
    case "robots_txt":
      return rec.status === 200
        ? { kind: "page", text: "Read robots.txt to see what the site allows a reader to open", data: base }
        : { kind: "page", text: `No robots.txt (HTTP ${rec.status}), so the site's public pages are open to read`, data: base };
    case "http_check": {
      const secure = (rec.finalUrl ?? "").startsWith("https:");
      return { kind: "page", text: secure ? "Plain http:// sends visitors on to the secure address" : "Plain http:// does not send visitors to the secure address", data: { ...base, secure } };
    }
    case "sitemap":
      return rec.status === 200
        ? { kind: "page", text: `Opened the sitemap at ${path}`, data: base }
        : { kind: "page", text: `No sitemap at ${path} (HTTP ${rec.status})`, data: base };
    case "site_page": {
      const ok = rec.status !== null && rec.status >= 200 && rec.status < 300;
      if (!ok) return { kind: "page", text: `${path} answered with HTTP ${rec.status}`, data: base };
      const clean = rec.title ? shortTitle(rec.title) : null;
      const title = clean ? ` "${clean}"` : "";
      return { kind: "page", text: `Read ${path}${title} in ${seconds(rec.ms)} (${Math.max(1, Math.round(rec.bytes / 1_024))} KB)`, data: { ...base, title: clean, bytes: rec.bytes, url: rec.finalUrl ?? rec.url } };
    }
  }
}

export function planLine(pages: LinkedPage[]): Line {
  if (!pages.length) return { kind: "note", text: "The home page links to no contact, booking, services or pricing page to open next" };
  const kinds = [...new Set(pages.map((p) => p.kind))];
  return { kind: "note", text: `Opening ${pages.length} page${pages.length === 1 ? "" : "s"} a buyer would look at next: ${kinds.join(", ")}`, data: { pages: pages.slice(0, 8).map((p) => ({ kind: p.kind, path: pathOf(p.url) })) } };
}

/** Checks that grade a quality rather than look for a thing: "good" or what is wrong, never "yes". */
const QUALITY: Partial<Record<CheckKey, string>> = {
  https: "not secure",
  mobile_viewport: "not set up for phones",
  html_size: "too heavy",
  response_time: "slow",
};

export function checkLines(checks: SiteCheck[]): Line[] {
  return checks.map((c) => {
    const quality = QUALITY[c.key];
    const tools = c.found.length ? ` (${c.found.slice(0, 3).join(", ")})` : "";
    const said =
      c.status === "unknown" ? "not known from outside" : quality ? (c.status === "yes" ? "good" : quality) : c.status === "yes" ? `found${tools}` : "missing";
    return { kind: "check", text: `${CHECK_TITLES[c.key]}: ${said}`, data: { key: c.key, status: c.status } };
  });
}

export function speedLine(ps: PageSpeedResult | null): Line {
  if (!ps) return { kind: "speed", text: "Google's phone test was not run for this scan; speed is judged from the server's answer", data: { ok: false } };
  if (!ps.ok) return { kind: "speed", text: `Google's phone test did not answer (${ps.error.replace(/_/g, " ")}); speed is judged from the server's answer`, data: { ok: false, error: ps.error } };
  const s = ps.scores;
  const parts = [s.performance !== null ? `speed ${s.performance}` : null, s.seo !== null ? `SEO ${s.seo}` : null, s.accessibility !== null ? `accessibility ${s.accessibility}` : null].filter(Boolean);
  return { kind: "speed", text: parts.length ? `Google's phone test: ${parts.join(", ")} out of 100` : "Google's phone test answered without scores", data: { ok: true, ...s } };
}

function list(xs: string[], n: number): string {
  return xs.slice(0, n).join(", ") + (xs.length > n ? ` and ${xs.length - n} more` : "");
}

export function signalLines(s: SiteSignals | null): Line[] {
  if (!s) return [];
  const out: Line[] = [];
  const say = (text: string, data?: Record<string, unknown>) => out.push({ kind: "signal", text, data });
  say(`The business calls itself "${s.business_name}"`, { field: "business_name", value: s.business_name });
  if (s.tagline) say(`Its headline: "${s.tagline.slice(0, 120)}"`, { field: "tagline" });
  if (s.localities.length) say(`Places it names: ${list(s.localities, 4)}`, { field: "localities", value: s.localities.slice(0, 6) });
  if (s.services.length) say(`Services it names: ${list(s.services, 4)}`, { field: "services", value: s.services.slice(0, 6) });
  say(s.phones.length ? `Phone on the site: ${s.phones[0]}` : "No phone number found on the pages read", { field: "phones", count: s.phones.length });
  if (s.emails.length) say(`Email on the site: ${s.emails[0]}`, { field: "emails", count: s.emails.length });
  say(s.booking_tools.length ? `Booking runs through ${list(s.booking_tools, 3)}` : "No online booking tool found", { field: "booking_tools", value: s.booking_tools });
  if (s.chat_tools.length) say(`Live chat by ${list(s.chat_tools, 2)}`, { field: "chat_tools", value: s.chat_tools });
  if (s.analytics.length) say(`It measures visitors with ${list(s.analytics, 3)}`, { field: "analytics", value: s.analytics });
  const socials = Object.keys(s.socials);
  if (socials.length) say(`Social profiles linked: ${list(socials, 5)}`, { field: "socials", value: socials });
  say(s.pricing_mentioned ? "Prices are shown on the site" : "No prices shown on the pages read", { field: "pricing_mentioned", value: s.pricing_mentioned });
  if (s.keywords.length) say(`Words the site leans on: ${s.keywords.slice(0, 6).map((k) => k.term).join(", ")}`, { field: "keywords" });
  if (s.language) say(`Written in ${s.language}`, { field: "language", value: s.language });
  return out;
}

export function scoreLines(score: ScanScore): Line[] {
  const out: Line[] = [];
  if (typeof score.total === "number") {
    const scored = score.pillars.filter((p) => typeof p.score === "number");
    const weakest = scored.reduce<(typeof scored)[number] | null>((w, p) => (w === null || (p.score as number) < (w.score as number) ? p : w), null);
    out.push({ kind: "score", text: `OASIS score: ${score.total} out of 100${weakest ? `. Weakest area: ${weakest.label} (${weakest.score})` : ""}`, data: { total: score.total } });
  } else {
    out.push({ kind: "score", text: "Too little of the site could be read from outside to give a score", data: { total: null } });
  }
  for (const f of score.fixes) out.push({ kind: "score", text: `Fix worth about +${f.impact} points: ${f.title}`, data: { fix: f.key, impact: f.impact } });
  return out;
}
