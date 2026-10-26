/**
 * lib/ai-audit/search.ts — web search for the Free AI Audit's research, run on
 * CC's Mac (system runner tool ai_audit_search: `claude -p` with the WebSearch
 * tool and nothing else, scripts/ai_audit/runner.py).
 *
 * WHAT THE MODEL IS GIVEN: public facts only, the business's name, website,
 * city and kind of business. Never the transcript, the call notes or anything
 * the client said: those stay in the Command Center.
 *
 * WHAT COMES BACK is a list of pages and the claims each states. None of it is
 * trusted: every address is checked (public web only, at most twelve), and the
 * Command Center then reads each page itself (lib/ai-audit/research.ts). A
 * claim becomes a Verified fact only when the stored copy of that page states
 * it (lib/ai-audit/evidence.ts). Pages that need a login are gaps.
 *
 * PURE: no I/O.
 */
import { INJECTION_GUARD, safeJsonExtract, wrapUntrusted } from "@/lib/llm-input-boundary";
import { isFetchableUrl } from "@/lib/ai-audit/site-url";
import { scrubCredentials } from "@/lib/ai-audit/transcript";
import { BUSINESS_TYPE_LABELS, type BusinessType } from "@/lib/ai-audit/rules";

export const SEARCH_SCHEMA = "ai_audit_search/v1" as const;
export const SEARCH_MAX_RESULTS = 12;
export const SEARCH_MAX_CLAIMS = 6;
/** Twelve results of six claims fit in far less: a longer answer is not read at all (its JSON scan grows with the square of its length). */
export const SEARCH_ANSWER_MAX_CHARS = 40_000;
const REFUSED_MAX = 20;
const HOST_MAX_CHARS = 120;
export const SEARCH_RESULT_KINDS = ["listing", "review", "social", "competitor", "industry"] as const;
export type SearchResultKind = (typeof SEARCH_RESULT_KINDS)[number];

export type SearchClaim = { text: string; value: number | null; unit: string | null };
export type SearchResult = { url: string; title: string; kind: SearchResultKind; claims: SearchClaim[] };

/** Hosts whose pages cannot be read without a login: listed as gaps, never read. */
export const LOGIN_WALLED = ["instagram.com", "facebook.com", "linkedin.com", "tiktok.com", "x.com", "twitter.com", "threads.net"];

export function loginWalled(u: URL): boolean {
  const h = u.hostname.toLowerCase().replace(/^www\./, "");
  return LOGIN_WALLED.some((d) => h === d || h.endsWith(`.${d}`));
}

const SYSTEM = [
  "You research a small business's public presence on the web for a free AI audit of that business.",
  "Use web search. Report only pages you found and only what each page itself states. Never guess, estimate or round a number.",
  "Look for: the business's own listings (Google Business Profile, Yelp, Better Business Bureau, directories), its review summaries (rating and review count, as shown), its social profiles, up to three nearby competitors of the same kind, and industry sources (associations, government or trade statistics) relevant to its kind of business.",
  `Answer with JSON only, in exactly this shape, at most ${SEARCH_MAX_RESULTS} results and ${SEARCH_MAX_CLAIMS} claims each:`,
  '{"results":[{"url":"https://...","title":"page title","kind":"listing|review|social|competitor|industry","claims":[{"text":"a short fact as the page states it","value":<the number in it, or null>,"unit":"stars|reviews|years|%|$|other, or null"}]}]}',
  "",
  INJECTION_GUARD,
].join("\n");

/** The search prompt: the business's public facts, fenced as data. */
export function searchPrompt(input: { businessName: string; website: string | null; city: string | null; businessType: BusinessType | null }): { system: string; prompt: string } {
  const clean = (s: string | null | undefined, max: number) => scrubCredentials((s ?? "").replace(/[\r\n]+/g, " ").trim().slice(0, max)).text;
  const facts = [
    `Business name: ${clean(input.businessName, 200) || "(not known)"}`,
    `Website: ${clean(input.website, 300) || "(none known)"}`,
    `City: ${clean(input.city, 120) || "(not known)"}`,
    `Kind of business: ${input.businessType ? BUSINESS_TYPE_LABELS[input.businessType] : "(not known)"}`,
  ].join("\n");
  return { system: SYSTEM, prompt: ["Research this business's public presence.", "", wrapUntrusted(facts, { label: "business facts", maxLen: 1_000 })].join("\n") };
}

function claimOf(v: unknown): SearchClaim | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const text = typeof o.text === "string" ? scrubCredentials(o.text.replace(/\s+/g, " ").trim()).text.slice(0, 300) : "";
  if (text.length < 3) return null;
  const value = typeof o.value === "number" && Number.isFinite(o.value) ? o.value : null;
  const unit = typeof o.unit === "string" && o.unit.trim() ? o.unit.trim().slice(0, 20) : null;
  return { text, value, unit };
}

/**
 * The model's answer as checked results, and what was refused. A result is kept
 * only with a public web address, a known kind, and no duplicate address.
 */
export function parseSearchAnswer(text: string): { ok: true; results: SearchResult[]; refused: string[] } | { ok: false; error: "unreadable" } {
  if (text.length > SEARCH_ANSWER_MAX_CHARS) return { ok: false, error: "unreadable" };
  const raw = safeJsonExtract(text);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "unreadable" };
  const list = (raw as { results?: unknown }).results;
  if (!Array.isArray(list)) return { ok: false, error: "unreadable" };
  const results: SearchResult[] = [];
  const refusals: string[] = [];
  // At most twenty, each naming a host of at most 120 characters (review of phase 3, F9: one was 190 KB).
  const refused = { push: (why: string) => void (refusals.length < REFUSED_MAX && refusals.push(why)) };
  const host = (u: URL) => u.hostname.slice(0, HOST_MAX_CHARS);
  const seen = new Set<string>();
  for (const item of list.slice(0, 40)) {
    if (results.length >= SEARCH_MAX_RESULTS) break;
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    let u: URL;
    try {
      u = new URL(typeof o.url === "string" ? o.url.trim() : "");
    } catch {
      refused.push("a result without a web address");
      continue;
    }
    if (u.protocol !== "https:" && u.protocol !== "http:") {
      refused.push(`${u.protocol.slice(0, 20)} is not a web address`);
      continue;
    }
    if (!isFetchableUrl(u)) {
      refused.push(`${host(u)} is not a public web address`);
      continue;
    }
    u.hash = "";
    const key = u.toString();
    if (seen.has(key)) continue;
    seen.add(key);
    const kind = (SEARCH_RESULT_KINDS as readonly string[]).includes(String(o.kind)) ? (o.kind as SearchResultKind) : null;
    if (!kind) {
      refused.push(`${host(u)}: no kind of page given`);
      continue;
    }
    const title = typeof o.title === "string" ? scrubCredentials(o.title.replace(/\s+/g, " ").trim()).text.slice(0, 200) : u.hostname;
    const claims = (Array.isArray(o.claims) ? o.claims : []).map(claimOf).filter((c): c is SearchClaim => !!c).slice(0, SEARCH_MAX_CLAIMS);
    results.push({ url: key.slice(0, 500), title: title || u.hostname, kind, claims });
  }
  return { ok: true, results, refused: refusals };
}
