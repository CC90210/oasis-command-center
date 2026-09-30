/**
 * lib/playbook/templates/context.ts - the only facts a document template may
 * use. "Draft it" builds a skeleton from these and nothing else; anything they
 * do not hold becomes [[CC to confirm: ...]] (confirm() below), and "Mark
 * current" is refused while one remains.
 *
 * Every fact comes from a verified constant or a table read at draft time:
 *   legal      lib/legal/constants.ts (entity, jurisdiction, privacy officer,
 *              contacts, sub-processors, data matrix, dates)
 *   finance    the business entity's fin_settings row (GST/QST registration)
 *   goal       the active revenue_goals row for the OASIS tenant
 * A read that failed is recorded as failed, so a template writes "could not
 * be read" instead of a default. Unknown is never zero.
 */

import type { Client } from "@libsql/client";
import {
  DATA_MATRIX,
  LEGAL_CONTACTS,
  LEGAL_EFFECTIVE_DATE,
  LEGAL_ENTITY,
  LEGAL_JURISDICTION,
  LEGAL_PRINCIPAL_PLACE,
  PRIVACY_LAST_UPDATED,
  PRIVACY_OFFICER,
  SUBPROCESSORS,
  type DataCategory,
  type Subprocessor,
} from "@/lib/legal/constants";
import { readGstQst } from "../live-sources";

export type Known<T> = { ok: true; value: T } | { ok: false; why: string };

export type GoalFacts = { label: string; targetCents: number; currency: string; periodStart: string; periodEnd: string };
export type FinanceFacts = { registered: boolean; gstNumber: string; qstNumber: string; effectiveDate: string | null; legalName: string };

export type TemplateContext = {
  /** Draft date, YYYY-MM-DD (the server clock). */
  today: string;
  legal: {
    entity: string;
    jurisdiction: string;
    principalPlace: string;
    effectiveDate: string;
    privacyLastUpdated: string;
    privacyOfficer: { name: string; titleEn: string; titleFr: string; email: string };
    contacts: { privacy: string; legal: string; dmca: string; support: string };
    subprocessors: readonly Subprocessor[];
    dataMatrix: readonly DataCategory[];
  };
  finance: Known<FinanceFacts>;
  goal: Known<GoalFacts | null>;
};

/** The placeholder every unknown becomes. */
export function confirm(what: string): string {
  return `[[CC to confirm: ${what}]]`;
}

export function legalFacts(): TemplateContext["legal"] {
  return {
    entity: LEGAL_ENTITY,
    jurisdiction: LEGAL_JURISDICTION,
    principalPlace: LEGAL_PRINCIPAL_PLACE,
    effectiveDate: LEGAL_EFFECTIVE_DATE,
    privacyLastUpdated: PRIVACY_LAST_UPDATED,
    privacyOfficer: {
      name: PRIVACY_OFFICER.name,
      titleEn: PRIVACY_OFFICER.title.en,
      titleFr: PRIVACY_OFFICER.title.fr,
      email: PRIVACY_OFFICER.email,
    },
    contacts: { ...LEGAL_CONTACTS },
    subprocessors: SUBPROCESSORS,
    dataMatrix: DATA_MATRIX,
  };
}

async function readGoal(db: Client, tenantId: string): Promise<Known<GoalFacts | null>> {
  try {
    const rs = await db.execute({
      sql: `SELECT label, target_cents, currency, period_start, period_end FROM revenue_goals
            WHERE tenant_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1`,
      args: [tenantId],
    });
    const r = rs.rows[0];
    if (!r) return { ok: true, value: null };
    return {
      ok: true,
      value: {
        label: String(r[0] ?? ""),
        targetCents: Number(r[1]),
        currency: String(r[2] ?? ""),
        periodStart: String(r[3] ?? ""),
        periodEnd: String(r[4] ?? ""),
      },
    };
  } catch (err) {
    console.error("[playbook.templates.goal]", err);
    return { ok: false, why: "the revenue goal could not be read when this draft was made" };
  }
}

async function readFinance(db: Client): Promise<Known<FinanceFacts>> {
  try {
    const g = await readGstQst(db);
    return { ok: true, value: { registered: g.registered, gstNumber: g.gstNumber, qstNumber: g.qstNumber, effectiveDate: g.effectiveDate, legalName: g.legalName } };
  } catch (err) {
    return { ok: false, why: err instanceof Error ? err.message : "the Finances settings could not be read" };
  }
}

/** Everything a template may use, read now. */
export async function loadTemplateContext(db: Client, tenantId: string, now: Date): Promise<TemplateContext> {
  const [finance, goal] = await Promise.all([readFinance(db), readGoal(db, tenantId)]);
  return { today: now.toISOString().slice(0, 10), legal: legalFacts(), finance, goal };
}

/** "US$6,000" from cents and currency; never a guessed currency. */
export function money(cents: number, currency: string): string {
  const prefix = currency === "USD" ? "US$" : currency === "CAD" ? "CA$" : `${currency} `;
  return `${prefix}${(cents / 100).toLocaleString("en-CA", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}
