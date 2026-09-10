/**
 * Shared vocabulary for the objection engine. NO I/O and no imports that reach
 * a database, because lib/web-leads/objections/ranking.ts imports this and must
 * stay testable in a bare node process.
 *
 * WHY `CatalogObjection` AND NOT `Objection`: lib/web-leads/angles.ts already
 * exports an `Objection` with a different shape (a single `response`, no id, no
 * status). The two must never be confused at a call site, so the database-backed
 * one carries the longer name.
 *
 * THE FOUR POSTURES ARE FIXED ON PURPOSE. A rep who is handed three rewordings
 * of one move has one move. The postures exist so the console shows genuinely
 * different actions, and so the Phase 3 scoreboard can answer "does taking it
 * away beat questioning back" rather than only "does answer B beat answer A".
 */

export const OBJECTION_FAMILIES = [
  "brush_off",
  "no_need",
  "no_money",
  "no_trust",
  "no_authority",
  "already_handled",
] as const;

export type ObjectionFamily = (typeof OBJECTION_FAMILIES)[number];

export const OBJECTION_POSTURES = [
  "agree_and_redirect",
  "question_back",
  "reframe_the_cost",
  "take_it_away",
] as const;

export type ObjectionPosture = (typeof OBJECTION_POSTURES)[number];

export const POSTURE_LABEL: Readonly<Record<ObjectionPosture, string>> = {
  agree_and_redirect: "Agree, then redirect",
  question_back: "Question it back",
  reframe_the_cost: "Reframe the cost",
  take_it_away: "Take it away",
};

export const OBJECTION_RESOLUTIONS = ["recovered", "stalled", "lost"] as const;
export type ObjectionResolution = (typeof OBJECTION_RESOLUTIONS)[number];

/** One answer. `body` is spoken verbatim; nothing else on it ever is. */
export type ObjectionAnswer = {
  id: string;
  label: string;
  body: string;
  posture: ObjectionPosture;
  isDefault: boolean;
  /** Set when a lead-tailored variant replaced `body`. The approved wording
   *  stays reachable in `libraryBody` so a rep can always read the reviewed
   *  sentence. */
  libraryBody?: string;
};

export type CatalogObjection = {
  id: string;
  slug: string;
  says: string;
  meaning: string;
  prevent: string;
  family: ObjectionFamily;
  source: string | null;
  /** Set only for the seven angle objections, naming the audit dimension they
   *  belong to, so ranking can favour the one matching the selected angle. */
  dimension: string | null;
  answers: ObjectionAnswer[];
};

/**
 * Everything the ranker is allowed to know. Deliberately a flat struct built by
 * lib/web-leads/objections/facts.ts rather than the audit object itself: the
 * ranker must stay a pure function over a small, stable input so its rules can
 * be tested exhaustively without a database or a fixture audit.
 */
export type ObjectionFacts = {
  hasWebsite: boolean;
  overallScore: number | null;
  dimensions: { key: string; score: number; weight: number }[];
  /** Lowercase platform name when the crawl identified a DIY builder, else null. */
  builderPlatform: string | null;
  /** Points the best-ranked competitor leads by, when known. */
  competitorGap: number | null;
  priorNoAnswerCalls: number;
  /** The angle key selectAngle() chose for this lead, when one was chosen. */
  selectedAngleKey: string | null;
};

export type ObjectionEventRecord = {
  id: string;
  objectionId: string;
  responseId: string | null;
  usedVariant: boolean;
  resolution: ObjectionResolution | null;
  occurredAt: string;
};

export function isObjectionFamily(v: unknown): v is ObjectionFamily {
  return typeof v === "string" && (OBJECTION_FAMILIES as readonly string[]).includes(v);
}

export function isObjectionPosture(v: unknown): v is ObjectionPosture {
  return typeof v === "string" && (OBJECTION_POSTURES as readonly string[]).includes(v);
}

export function isObjectionResolution(v: unknown): v is ObjectionResolution {
  return typeof v === "string" && (OBJECTION_RESOLUTIONS as readonly string[]).includes(v);
}

/**
 * Same shape and same reasoning as isCallOutcomeRequestId in
 * lib/web-leads/outcome.ts: a client-stable UUID is what makes a retry from a
 * rep's flaky phone tether idempotent instead of a second logged objection.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isRequestId(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}
