/**
 * The four gates a rep confirms before a founder meeting is booked, in ONE
 * place for Pipeline (app/pipeline/[id]/LeadLifecycleActions.tsx), the website
 * sales route, and the call screen. Pure and client-safe.
 *
 * THE STORED KEY IS NOT THE WORDING (Adon, 2026-10-01). Gate 2 used to read
 * "Website problem confirmed". OASIS now sells operations systems, so it reads
 * "Operations pain named in their own words". The stored and wire key stays
 * `websiteProblemConfirmed` because:
 *   - nothing reads that key back for display; the meaning lives in the label;
 *   - renaming the wire key breaks every Pipeline tab left open across a
 *     deploy (old client sends the old key, server answers qualify_before_booking);
 *   - every stored qualification record would need a migration for no gain.
 * tests/sales-qualification.test.ts pins the key list so this cannot drift.
 *
 * GATE 4 STILL NAMES THE STARTER PRICE. The rep script, the AI next-action
 * prompt and the commission maths all quote $500 setup + $150/month, and
 * tests/website-sales-surface.test.ts pins the gate to that live price. A gate
 * that quoted a different number from the script on the next screen would put
 * two prices in front of a rep, so it moves only when the price surface does.
 */
export const QUALIFICATION_GATE_KEYS = [
  "authorityConfirmed",
  "websiteProblemConfirmed",
  "timingConfirmed",
  "minimumInvestmentConfirmed",
] as const;

export type QualificationGateKey = (typeof QUALIFICATION_GATE_KEYS)[number];

export type QualificationGate = { key: QualificationGateKey; label: string; hint: string };

export const QUALIFICATION_GATES: readonly QualificationGate[] = [
  {
    key: "authorityConfirmed",
    label: "Owner or decision-maker",
    hint: "They own the business or sign off on spending.",
  },
  {
    key: "websiteProblemConfirmed",
    label: "Operations pain named in their own words",
    hint: "They described a real problem with calls, quotes, jobs or follow-ups.",
  },
  {
    key: "timingConfirmed",
    label: "Would act within 90 days",
    hint: "They want to fix it this quarter, not someday.",
  },
  {
    key: "minimumInvestmentConfirmed",
    label: "Open to $500 setup + $150/month",
    hint: "They know the next step is paid work.",
  },
];

/** Longest "in their words" quote stored on the qualification record. */
export const PAIN_WORDS_MAX = 500;

export type StoredQualification = Record<QualificationGateKey, boolean> & {
  operationsPainInTheirWords?: string;
};

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** The WIRE check: every gate must be literal `true`. Same strictness route.ts had. */
export function isCompleteQualificationPayload(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const q = value as Record<string, unknown>;
  return QUALIFICATION_GATE_KEYS.every((key) => q[key] === true);
}

/**
 * What the server stores: four booleans and, when given, the owner's words.
 * Nothing else, so a client can no longer write arbitrary JSON into the record.
 */
export function normalizeQualificationForStorage(value: unknown): StoredQualification {
  const q = asObject(value);
  const stored: StoredQualification = {
    authorityConfirmed: q.authorityConfirmed === true,
    websiteProblemConfirmed: q.websiteProblemConfirmed === true,
    timingConfirmed: q.timingConfirmed === true,
    minimumInvestmentConfirmed: q.minimumInvestmentConfirmed === true,
  };
  const words = typeof q.operationsPainInTheirWords === "string"
    ? q.operationsPainInTheirWords.trim().slice(0, PAIN_WORDS_MAX)
    : "";
  if (words) stored.operationsPainInTheirWords = words;
  return stored;
}

/**
 * The READ side, tolerant of every shape a stored record can take: an object,
 * JSON text (libSQL returns JSON columns as TEXT), booleans as 1/0, and records
 * written before the wording change (which may also carry `notes`).
 */
export function readStoredQualification(raw: unknown): {
  gates: Record<QualificationGateKey, boolean>;
  operationsPainInTheirWords: string | null;
  complete: boolean;
} {
  let value = raw;
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { value = null; }
  }
  const q = asObject(value);
  const gates = Object.fromEntries(
    QUALIFICATION_GATE_KEYS.map((key) => [key, q[key] === true || q[key] === 1]),
  ) as Record<QualificationGateKey, boolean>;
  const words = typeof q.operationsPainInTheirWords === "string" && q.operationsPainInTheirWords.trim()
    ? q.operationsPainInTheirWords.trim()
    : null;
  return { gates, operationsPainInTheirWords: words, complete: QUALIFICATION_GATE_KEYS.every((key) => gates[key]) };
}
