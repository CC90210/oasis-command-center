/**
 * lib/integrations/blast-safety-core.ts — PURE merchant-facing blast guards.
 * No `server-only`, no DB — so it's unit-testable (tests/blast-safety.test.ts).
 * The DB-backed wrapper (reads the tenant's lender list) lives in blast-safety.ts.
 */

const DASHES = /[—–]/g; // em dash, en dash → hyphen (no em dashes in customer copy)

export function stripDashes(s: string): string {
  return s.replace(DASHES, "-");
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A lender "name" that is a single ultra-generic industry/English word matches
 * far too broadly: a funder literally named "Funding" or "Advance" (or a "test"
 * junk record, or the tenant's own brand) would flag EVERY email's signature or
 * subject and fail-closed the whole drip channel. Skip a name that IS one of
 * these on its own — real multi-word names ("Mint Funding", "True Advance") are
 * unaffected because they only match as the full phrase. (2026-07-20 hardening:
 * the SunBiz lender table held generic + "TEST" junk records.)
 */
const GENERIC_NAME_STOPWORDS = new Set([
  "funding", "capital", "advance", "advances", "business", "finance", "financial",
  "lending", "loan", "loans", "merchant", "solutions", "partners", "holdings",
  "group", "corp", "corporation", "inc", "llc", "the", "test", "sunbiz",
]);

/**
 * Which of `names` appear in `text` (case-insensitive, word-boundary so
 * "Rapid" doesn't match "rapidly"). Names under 3 chars, or a single generic
 * stopword, are skipped to avoid false positives that would block clean copy.
 */
export function matchLenderNames(text: string, names: string[]): string[] {
  const hay = (text || "").toLowerCase();
  const hits: string[] = [];
  for (const raw of names) {
    const name = (raw || "").trim();
    if (name.length < 3) continue;
    if (GENERIC_NAME_STOPWORDS.has(name.toLowerCase())) continue;
    const re = new RegExp(`(^|[^a-z0-9])${escapeRegex(name.toLowerCase())}([^a-z0-9]|$)`, "i");
    if (re.test(hay) && !hits.includes(name)) hits.push(name);
  }
  return hits;
}

/**
 * DIRECT-LENDER POSITIONING guard (hardwired 2026-07-10). SunBiz positions AS a
 * direct lender/funder to merchants — it must NEVER imply it brokers to other
 * lenders. This blocks the generic broker-positioning phrase families (not just
 * NAMED lenders, which matchLenderNames covers). Whitespace-flexible + anchored
 * to keep false-positives near zero; note it deliberately does NOT block
 * self-references like "we're a direct lender" / "your lender" (SunBiz itself).
 * Returns the human labels of any families that hit.
 */
const POSITIONING_PATTERNS: { re: RegExp; label: string }[] = [
  { re: /\bour\s+lenders?\b/i, label: "our lender(s)" },
  { re: /\blender\s+network\b/i, label: "lender network" },
  { re: /\bnetwork\s+of\s+lenders?\b/i, label: "network of lenders" },
  { re: /\blenders?\s+we\s+work\s+with\b/i, label: "lenders we work with" },
  { re: /\bwe\s+work\s+with\s+(?:the\s+|our\s+)?lenders?\b/i, label: "we work with lenders" },
  { re: /\blender\s+programs?\b/i, label: "lender programs" },
  { re: /\bfunding\s+partners?\b/i, label: "funding partners" },
  { re: /\bfunders?\s+we\s+work\s+with\b/i, label: "funders we work with" },
  { re: /\b\d\s*(?:-|–|to)\s*\d\s+lender\s+offers?\b/i, label: "N-N lender offers" },
  { re: /\bto\s+(?:the\s+|our\s+)?lenders?\b/i, label: "to lenders" },
  { re: /\bno\s+lenders?\s+can\b/i, label: "no lender can" },
  { re: /\bshop\s+(?:your\s+)?(?:file|deal|it)\b/i, label: "shop your file" },
  // Additions (2026-07-19, merchant-copy compliance sweep). Still anchored to
  // broker-implying constructions so "your positions with lenders" (the
  // merchant's OWN debt) never trips.
  { re: /\bwhat\s+lenders?\b/i, label: "what lenders" },
  { re: /\bpanel\s+of\s+lenders?\b/i, label: "panel of lenders" },
  { re: /\beach\s+lenders?\b/i, label: "each lender" },
  { re: /\bthe\s+lender\s+(?:wires?|approves?|prices?|needs?|pays?)\b/i, label: "the lender <acts>" },
  { re: /\bget\s+shopped\b/i, label: "get shopped" },
  { re: /\bshopped\s+(?:around|out)\b/i, label: "shopped around" },
  // Broker-as-intermediary constructions (2026-07-20 rotation review — the AI
  // rewrite seam is the first FREE-FORM copy generator, so the deterministic
  // guard is the real backstop). Deliberately NARROW: we do NOT block bare
  // "broker", so legit direct-funder positioning ("we cut out the broker",
  // "we're not a broker") still passes, matching the self-reference carve-out.
  { re: /\bour\s+brokers?\b/i, label: "our broker(s)" },
  { re: /\bthrough\s+(?:a\s+|the\s+|our\s+)?brokers?\b/i, label: "through a broker" },
  { re: /\bbrokered\s+(?:out|to)\b/i, label: "brokered out/to" },
];

export function matchPositioningPhrases(text: string): string[] {
  const hay = (text || "").replace(/\s+/g, " ");
  const hits: string[] = [];
  for (const { re, label } of POSITIONING_PATTERNS) {
    if (re.test(hay) && !hits.includes(label)) hits.push(label);
  }
  return hits;
}
