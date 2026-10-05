/**
 * lib/jev/mode.ts - whether a workspace asks Jev at all, and what happens to
 * the answer when it does. SHADOW FIRST (CC, 2026-09-29).
 *
 * THE MODE, per workspace:
 *   off     nothing is sent to Jev.
 *   shadow  the normal path decides, exactly as it would without Jev. Jev is
 *           asked the same question afterwards, and only the TELEMETRY is kept
 *           (jev_calls: surface, mode, outcome, latency, whether it agreed,
 *           token count). No text, no answer, no key.
 *   on      accepted in a manifest, but OCC does not let Jev decide anything
 *           yet: it runs exactly as shadow and says so on the card.
 * Read from manifest.integrations.jev (written by onboarding, track T7). A
 * missing or unreadable value is the default: shadow for OASIS's own
 * workspace, off for every client workspace. Stored manifests from before the
 * integrations object (a bare array) have no value, so they get the default.
 *
 * AND A KEY. Every mode but off also needs the workspace's own TypeSafe key
 * (Settings > AI brain, the Jev card). No key, no call: shadow without a key
 * sends nothing.
 *
 * JEV'S ANSWER IS DATA. runShadow returns the value the normal path decided,
 * always; its only side effect is one telemetry row per question. It never
 * sends, approves, routes or changes anything, and it never throws into the
 * path it shadows.
 *
 * The first two surfaces:
 *   slack.general_routing  which department should take an un-@mentioned
 *                          message in a mapped general channel (the normal
 *                          path: nobody, it stays "general");
 *   support_intake.*       the priority and category of a new support ticket
 *                          (the normal path: what the requester chose).
 */
import "server-only";
import { randomUUID } from "node:crypto";
import type { Client } from "@libsql/client";
import { OASIS_OPERATOR_TENANT_ID } from "@/lib/platform-operator";
import { findActiveConnection } from "@/lib/connections/store";
import { credentialServiceFor } from "@/lib/connections/rules";
import { readTenantCredentialStrict } from "@/lib/tenant-integration-store";
import { OS_DEPARTMENTS } from "@/lib/os/departments";
import { TICKET_CATEGORIES, TICKET_CATEGORY_LABELS, TICKET_SEVERITIES, TICKET_SEVERITY_LABELS } from "@/lib/delivery/rules";
import { classify, type JevCallOpts, type JevQuestion, type JevResult } from "@/lib/jev/client";

/**
 * NOT YET APPROVED: no workspace text goes to TypeSafe. TypeSafe (hosted in the
 * United States) is not on OASIS's published list of processors (/privacy), and
 * sending personal information outside Quebec needs CC's decision first (a Law
 * 25 privacy impact assessment and TypeSafe's DPA). Until this is flipped, in
 * the SAME change that lists TypeSafe on /privacy, every shadow run stops here
 * and only the key check (list models, which sends no data) ever calls
 * TypeSafe. tests/legal-compliance-drift.test.ts holds the two together.
 */
export const JEV_TEXT_PROCESSING_APPROVED = false;

export const JEV_MODES = ["off", "shadow", "on"] as const;
export type JevMode = (typeof JEV_MODES)[number];

export const JEV_SURFACES = ["slack.general_routing", "support_intake.priority", "support_intake.category"] as const;
export type JevSurface = (typeof JEV_SURFACES)[number];

export type ResolvedJevMode = { mode: JevMode; source: "manifest" | "default" };

/** The default when the manifest says nothing: OASIS shadows, clients are off. */
export function defaultJevMode(tenantId: string): JevMode {
  return tenantId === OASIS_OPERATOR_TENANT_ID ? "shadow" : "off";
}

/**
 * The mode from a manifest's `integrations` value, whatever shape it has. Only
 * an object carrying a known `jev` string counts; anything else (absent, an old
 * array, a typo) is the default.
 */
export function resolveJevMode(tenantId: string, integrations: unknown): ResolvedJevMode {
  if (integrations && typeof integrations === "object" && !Array.isArray(integrations)) {
    const v = (integrations as Record<string, unknown>).jev;
    if (typeof v === "string" && (JEV_MODES as readonly string[]).includes(v)) return { mode: v as JevMode, source: "manifest" };
  }
  return { mode: defaultJevMode(tenantId), source: "default" };
}

/** The chat apps the owner said the team uses (manifest.integrations.chat_apps); [] when absent. */
export function chatAppsFrom(integrations: unknown): string[] {
  if (!integrations || typeof integrations !== "object" || Array.isArray(integrations)) return [];
  const v = (integrations as Record<string, unknown>).chat_apps;
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/**
 * The workspace's manifest `integrations` value, raw (not through the typed
 * parser, which on older code does not know the object shape). Null when the
 * workspace has no manifest; a read that fails throws.
 */
export async function readManifestIntegrations(db: Client, tenantId: string): Promise<unknown> {
  const rs = await db.execute({
    sql: "SELECT manifest FROM tenant_manifests WHERE tenant_id = ? ORDER BY updated_at DESC LIMIT 1",
    args: [tenantId],
  });
  const raw = rs.rows[0] ? (rs.rows[0] as unknown as Record<string, unknown>).manifest : null;
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    const m = JSON.parse(raw) as Record<string, unknown>;
    return m && typeof m === "object" ? m.integrations ?? null : null;
  } catch {
    console.error("[jev.mode] the workspace manifest is not valid JSON; using the default mode", { tenantId });
    return null;
  }
}

export async function readJevMode(db: Client, tenantId: string): Promise<ResolvedJevMode> {
  return resolveJevMode(tenantId, await readManifestIntegrations(db, tenantId));
}

/** The workspace's own TypeSafe key, from its live Jev connection, or null (not connected / refused). */
export async function jevKeyFor(db: Client, tenantId: string): Promise<string | null> {
  const conn = await findActiveConnection(db, tenantId, "jev");
  if (!conn || conn.status === "expired" || conn.status === "error") return null;
  const key = await readTenantCredentialStrict(tenantId, credentialServiceFor(conn.id), "api_key");
  if (!key.ok) {
    if (key.reason === "lookup_failed") throw new Error("jev key lookup failed");
    return null;
  }
  return key.value;
}

export type ShadowQuestion = {
  /** jev_calls.surface for this question. */
  surface: JevSurface;
  /** The Choice question sent to Jev. */
  question: JevQuestion & { type: "choice" };
  /** The label the normal path chose. */
  decided: string;
};

export type ShadowDeps = {
  db: Client;
  now: () => Date;
  classifyImpl?: (input: Parameters<typeof classify>[0], opts?: JevCallOpts) => Promise<JevResult>;
  jevOpts?: JevCallOpts;
  /** Test seams; production reads the manifest and the key store. */
  mode?: ResolvedJevMode;
  apiKey?: string | null;
  /** Test seam only: exercise the shadow as it will run once TypeSafe is approved. Production never sets it. */
  processorApprovedForTest?: boolean;
};

export type ShadowRun = { asked: boolean; rows: number; reason: "not_approved" | "off" | "no_key" | "asked" | "failed" };

/**
 * Ask Jev the same questions the normal path already answered, record ONLY
 * telemetry, and change nothing. Returns what happened; never throws.
 */
export async function runShadow(
  deps: ShadowDeps,
  input: { tenantId: string; state: string | Record<string, unknown>; questions: readonly ShadowQuestion[] },
): Promise<ShadowRun> {
  try {
    // No text leaves for TypeSafe until OASIS lists it as a processor.
    if (!JEV_TEXT_PROCESSING_APPROVED && deps.processorApprovedForTest !== true) return { asked: false, rows: 0, reason: "not_approved" };
    const mode = deps.mode ?? (await readJevMode(deps.db, input.tenantId));
    if (mode.mode === "off") return { asked: false, rows: 0, reason: "off" };
    const apiKey = deps.apiKey !== undefined ? deps.apiKey : await jevKeyFor(deps.db, input.tenantId);
    if (!apiKey) return { asked: false, rows: 0, reason: "no_key" };

    const questions: Record<string, JevQuestion> = {};
    input.questions.forEach((q, i) => {
      questions[`q${i}`] = q.question;
    });
    const result = await (deps.classifyImpl ?? classify)({ apiKey, state: input.state, questions }, deps.jevOpts);
    const nowIso = deps.now().toISOString();
    const rows = input.questions.map((q, i) => {
      const answer = result.ok ? result.answers[`q${i}`] : null;
      const agreed = answer && answer.type === "choice" ? (answer.choice === q.decided ? 1 : 0) : null;
      return {
        sql: `INSERT INTO jev_calls (id, tenant_id, surface, mode, outcome, latency_ms, agreed, input_tokens, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          randomUUID(),
          input.tenantId,
          q.surface,
          mode.mode,
          result.ok ? "ok" : result.failure,
          result.latencyMs,
          agreed,
          result.ok && i === 0 ? result.usage.inputTokens : null,
          nowIso,
        ],
      };
    });
    await deps.db.batch(rows, "write");
    if (!result.ok) console.error("[jev.shadow] Jev did not answer", { tenantId: input.tenantId, failure: result.failure, status: result.status });
    return { asked: true, rows: rows.length, reason: result.ok ? "asked" : "failed" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/no such table/i.test(message)) {
      // A database without the Connections or Jev tables (bravo__187 /
      // bravo__197 not applied): there is nothing to shadow with. Said once.
      if (!schemaMissingWarned) {
        schemaMissingWarned = true;
        console.warn("[jev.shadow] Jev tables are not installed on this database; shadow is off", { error: message.slice(0, 200) });
      }
      return { asked: false, rows: 0, reason: "off" };
    }
    console.error("[jev.shadow] shadow run failed; the normal path was not affected", { tenantId: input.tenantId, error: message });
    return { asked: false, rows: 0, reason: "failed" };
  }
}

let schemaMissingWarned = false;

// -- The two surfaces ---------------------------------------------------------

export const GENERAL_LABEL = "general";

/** The departments plus "general", as Jev's choice labels. */
export function departmentRoutingQuestion(): JevQuestion & { type: "choice" } {
  const criteria: Record<string, string | null> = { [GENERAL_LABEL]: "General team chat that no single department needs to act on" };
  for (const d of OS_DEPARTMENTS) criteria[d.key] = `The ${d.label} department should take this message`;
  return { type: "choice", instructions: "Which department of the business should take this message?", criteria };
}

/** Surface (a): an un-@mentioned message in a mapped general channel. The normal path leaves it "general". */
export function shadowGeneralChannelRouting(db: Client, input: { tenantId: string; text: string; now: Date }, deps: Partial<ShadowDeps> = {}): Promise<ShadowRun> {
  if (!input.text.trim()) return Promise.resolve({ asked: false, rows: 0, reason: "off" });
  return runShadow(
    { db, now: () => input.now, ...deps },
    {
      tenantId: input.tenantId,
      state: input.text.slice(0, 4000),
      questions: [{ surface: "slack.general_routing", question: departmentRoutingQuestion(), decided: GENERAL_LABEL }],
    },
  );
}

/** Surface (b): a new support ticket's priority and category. The normal path keeps what the requester chose. */
export function shadowSupportTriage(
  db: Client,
  input: { tenantId: string; title: string; description: string; category: string; severity: string; now: Date },
  deps: Partial<ShadowDeps> = {},
): Promise<ShadowRun> {
  const category: Record<string, string | null> = {};
  for (const c of TICKET_CATEGORIES) category[c] = TICKET_CATEGORY_LABELS[c];
  const severity: Record<string, string | null> = {};
  for (const s of TICKET_SEVERITIES) severity[s] = TICKET_SEVERITY_LABELS[s];
  return runShadow(
    { db, now: () => input.now, ...deps },
    {
      tenantId: input.tenantId,
      state: { title: input.title, description: input.description.slice(0, 4000) },
      questions: [
        { surface: "support_intake.priority", question: { type: "choice", instructions: "How urgent is this support request?", criteria: severity }, decided: input.severity },
        { surface: "support_intake.category", question: { type: "choice", instructions: "What kind of support request is this?", criteria: category }, decided: input.category },
      ],
    },
  );
}

// -- The card's numbers -----------------------------------------------------------

export type JevStats = {
  calls: number;
  lastLatencyMs: number | null;
  lastAt: string | null;
  /** Agreement over answered calls in the window; null when none (unknown is never 0%). */
  agreementPct: number | null;
  answered: number;
  failed: number;
};

/** The last 30 days of this workspace's Jev telemetry. A missing table (bravo__197) throws for the caller to report. */
export async function jevStats(db: Client, tenantId: string, now: Date): Promise<JevStats> {
  const since = new Date(now.getTime() - 30 * 86_400_000).toISOString();
  const rs = await db.execute({
    sql: `SELECT COUNT(*) AS calls,
                 SUM(CASE WHEN agreed IS NOT NULL THEN 1 ELSE 0 END) AS answered,
                 SUM(CASE WHEN agreed = 1 THEN 1 ELSE 0 END) AS agreed,
                 SUM(CASE WHEN outcome <> 'ok' THEN 1 ELSE 0 END) AS failed
          FROM jev_calls WHERE tenant_id = ? AND created_at >= ?`,
    args: [tenantId, since],
  });
  const last = await db.execute({
    sql: "SELECT latency_ms, created_at FROM jev_calls WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 1",
    args: [tenantId],
  });
  const r = rs.rows[0] as unknown as Record<string, unknown>;
  const answered = Number(r?.answered ?? 0) || 0;
  const agreed = Number(r?.agreed ?? 0) || 0;
  const l = last.rows[0] as unknown as Record<string, unknown> | undefined;
  return {
    calls: Number(r?.calls ?? 0) || 0,
    answered,
    failed: Number(r?.failed ?? 0) || 0,
    agreementPct: answered > 0 ? Math.round((agreed / answered) * 100) : null,
    lastLatencyMs: l && l.latency_ms !== null && l.latency_ms !== undefined ? Number(l.latency_ms) : null,
    lastAt: l ? String(l.created_at) : null,
  };
}
