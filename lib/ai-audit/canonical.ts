/**
 * lib/ai-audit/canonical.ts — one byte form for a JSON document.
 *
 * PURE (no node:crypto), so the browser editor and the server agree on what a
 * document IS. Object keys are sorted at every depth and undefined values are
 * dropped; arrays keep their order, because order is meaning (section order,
 * line order). The server hashes this string (hash.ts); the approval gates
 * bind to that hash, so a single changed character is a different document.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[k];
      if (v !== undefined) out[k] = sortKeys(v);
    }
    return out;
  }
  return value;
}
