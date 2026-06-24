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
 * Which of `names` appear in `text` (case-insensitive, word-boundary so
 * "Rapid" doesn't match "rapidly"). Names under 3 chars are skipped to avoid
 * false positives.
 */
export function matchLenderNames(text: string, names: string[]): string[] {
  const hay = (text || "").toLowerCase();
  const hits: string[] = [];
  for (const raw of names) {
    const name = (raw || "").trim();
    if (name.length < 3) continue;
    const re = new RegExp(`(^|[^a-z0-9])${escapeRegex(name.toLowerCase())}([^a-z0-9]|$)`, "i");
    if (re.test(hay) && !hits.includes(name)) hits.push(name);
  }
  return hits;
}
