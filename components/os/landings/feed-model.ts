/**
 * feed-model — which Feed rows a viewer may see, which department did the
 * work, and what counts as shipped. PURE: no session, no database, so
 * tests/os-landings.test.ts runs every rule in bare node.
 *
 * WHO SEES THE TAPE. Until 2026-09-28 these rows were reachable only on
 * /operations (/feed redirected there), behind requireSystemSurface. The Feed
 * is now a Team row for everyone, so the tape keeps its old audience:
 * `canSeeSystemSurfaces`. Everyone else gets the Feed's Needs-you tab (their
 * approval cards, lib/os/approvals), and no raw event rows. A rep does not
 * get a firehose of other reps' call and email events by way of a new tab.
 *
 * Within the tape, two more cuts, both server-side before render:
 *   - a row attributed to a department the viewer cannot open is dropped
 *     (Finance, for anyone who is not an owner);
 *   - a row whose payload carries money fields is dropped unless the viewer
 *     may read company financials. projectEvent's summary prints amount_cad /
 *     net_mrr_usd verbatim, so hiding the column would still ship the number.
 *
 * DEPARTMENT ATTRIBUTION is explicit, not inferred from prose. agent_events has
 * no department column yet; the design (01 §Risks 2) has producers emit
 * `publisher_agent = dept:<key>` from now on, and OASIS binds its existing
 * agents to departments (Chief of Staff → bravo, Marketing → maven,
 * Finance → atlas). Anything else is unattributed and shows under "All
 * departments" only.
 *
 * NAMES ON THE TAPE (feedSystemName, feedPublisherLabel, feedAgentName,
 * displayPayload, feedSummary). The system names a row carries (its publisher,
 * its event name, the agent its payload names) never print a house agent or
 * the operator (lib/os/channel/identity.ts): a house agent is written as the
 * department it leads, and a workspace other than OASIS never reads an OASIS
 * producer's internal name ("Workspace" instead). The row's own data (a
 * subject, a note, a lead's name) is the workspace's: in OASIS it prints as
 * written ("Atlas Roofing" is a lead, not an agent); anywhere else a summary
 * that still names a house agent or the operator is not shown at all, because
 * free text cannot be told apart from a lead's name and is never rewritten.
 */

import type { DepartmentKey } from "@/lib/os/types";
import { formatPublisher } from "@/lib/event-bus-display";
import { namesPersona } from "@/lib/os/channel/identity";
import { OS_DEPARTMENTS } from "@/lib/os/departments";
import { withDepartmentNames } from "@/components/os/department/config";

export type FeedEventRow = {
  id: string;
  event_type: string;
  publisher_agent: string | null;
  target_agent: string | null;
  severity: string | null;
  payload: unknown;
  published_at: string | null;
  created_at: string | null;
  status: string | null;
};

export type FeedTab = "needs" | "all" | "shipped";

export const FEED_TABS: ReadonlyArray<{ key: FeedTab; label: string }> = [
  { key: "needs", label: "Needs you" },
  { key: "all", label: "All" },
  { key: "shipped", label: "Shipped" },
];

const DEPARTMENT_KEYS: ReadonlySet<DepartmentKey> = new Set<DepartmentKey>([
  "chief_of_staff",
  "sales",
  "marketing",
  "client_success",
  "finance",
  "operations",
]);

/**
 * Producers bound to a department. OASIS's own agents per the design doc's
 * binding table; Kixie is the Sales call line; drip sequences are Marketing's
 * campaigns. Keys are lowercased publisher_agent values.
 */
export const PUBLISHER_DEPARTMENT: Readonly<Record<string, DepartmentKey>> = {
  bravo: "chief_of_staff",
  maven: "marketing",
  atlas: "finance",
  kixie: "sales",
  sequences: "marketing",
};

/**
 * A system name (a publisher slug, an event name, the agent a payload names)
 * as a person reads it: a house agent is written as the department it leads
 * ("Bravo scheduler" becomes "Chief of Staff scheduler"), and anything still
 * naming a persona is not shown at all (null).
 */
export function feedSystemName(text: string): string | null {
  const named = namesPersona(text) ? withDepartmentNames(text) : text;
  return namesPersona(named) ? null : named;
}

/**
 * Who a row says did the work when no department claims it. A workspace other
 * than OASIS reads "Workspace": a slug like "oasis_lead_stage_engine" or
 * "manifest-data" is OASIS's plumbing, not a name its owner knows. OASIS reads
 * the producer itself, through feedSystemName.
 */
export function feedPublisherLabel(publisher: string | null, oasisWorkspace: boolean): string {
  const slug = (publisher || "").trim();
  if (!slug) return "Unattributed";
  if (!oasisWorkspace) return "Workspace";
  return feedSystemName(formatPublisher(slug)) ?? "Workspace";
}

/**
 * The name an agent field in a row's payload prints, by the publisher
 * column's own rule (FeedView: the department, else feedPublisherLabel). A
 * producer bound to a department (PUBLISHER_DEPARTMENT, `dept:<key>`) reads as
 * that department. Any other value is a slug like "bravo_scheduler",
 * "maven-publisher" or "oasis_lead_stage_engine": OASIS reads it formatted
 * through the persona rule ("Chief of Staff scheduler"), every other workspace
 * reads "Workspace". The slug is formatted before the rule runs because the
 * persona pattern's word boundary does not split "bravo_scheduler".
 */
export function feedAgentName(value: string, oasisWorkspace: boolean): string {
  const dept = departmentForEvent({ publisher_agent: value });
  if (dept) return OS_DEPARTMENTS.find((d) => d.key === dept)?.label ?? "Workspace";
  return feedPublisherLabel(value, oasisWorkspace);
}

/** Payload keys that hold an agent's name: system identifiers a summary can print. */
const AGENT_PAYLOAD_KEYS: readonly string[] = ["agent", "agent_key", "source_agent", "publisher", "publisher_agent"];

/**
 * The payload a row's summary is built from (lib/event-projection.ts prints
 * "bravo · tick" and "agent=bravo"), with each agent name written through
 * feedAgentName for this viewer. Only those identifier fields change; the
 * row's own data is left for feedSummary.
 */
export function displayPayload(payload: unknown, oasisWorkspace: boolean): unknown {
  const p = payloadObject(payload);
  let out: Record<string, unknown> | null = null;
  for (const key of AGENT_PAYLOAD_KEYS) {
    const v = p[key];
    if (typeof v !== "string" || !v.trim()) continue;
    const name = feedAgentName(v, oasisWorkspace);
    if (name === v) continue;
    out = out ?? { ...p };
    out[key] = name;
  }
  return out ?? payload;
}

/**
 * A row's one-line summary as this viewer may read it, or null for no line.
 * Its agent names are already this viewer's (displayPayload). What is left is
 * the row's own data: in OASIS it prints as written; in any other workspace a
 * summary that still names a house agent or the operator ("Bravo synced 12
 * leads for Conaugh", a send to the operator's mailbox) is dropped, never
 * rewritten, so a client's lead called "Atlas Roofing" is never printed as
 * "Finance Roofing" either.
 */
export function feedSummary(summary: string, oasisWorkspace: boolean): string | null {
  const text = summary.trim();
  if (!text) return null;
  if (!oasisWorkspace && namesPersona(text)) return null;
  return text;
}

/** The department that produced a row, or null when nothing says. */
export function departmentForEvent(row: Pick<FeedEventRow, "publisher_agent">): DepartmentKey | null {
  const publisher = (row.publisher_agent || "").trim().toLowerCase();
  if (!publisher) return null;
  if (publisher.startsWith("dept:")) {
    const key = publisher.slice(5) as DepartmentKey;
    return DEPARTMENT_KEYS.has(key) ? key : null;
  }
  return PUBLISHER_DEPARTMENT[publisher] ?? null;
}

/**
 * Payload fields that are company money. A row carrying any of them is company
 * financial data, whichever agent wrote it.
 */
export const MONEY_PAYLOAD_KEYS: readonly string[] = [
  "amount",
  "amount_cad",
  "amount_usd",
  "amount_cents",
  "mrr",
  "net_mrr_usd",
  "mrr_cents",
  "revenue",
  "revenue_cents",
  "balance_cents",
  "invoice_id",
];

export function payloadObject(payload: unknown): Record<string, unknown> {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) return payload as Record<string, unknown>;
  if (typeof payload === "string") {
    try {
      const parsed = JSON.parse(payload);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      // Not JSON: treated as an empty payload, same as lib/event-projection.ts.
    }
  }
  return {};
}

export function carriesMoney(row: Pick<FeedEventRow, "payload">): boolean {
  const p = payloadObject(row.payload);
  return MONEY_PAYLOAD_KEYS.some((k) => p[k] !== undefined && p[k] !== null && p[k] !== "");
}

/**
 * Outward work that left the business: a send, a publish, a launch. An error
 * row is never "shipped", whatever its type says.
 */
const SHIPPED_TYPE = /(OUTBOUND_SENT|^outbound\.recorded$|_SENT$|\.sent$|PUBLISHED|\.published$|LAUNCHED|DELIVERED)/i;

export function isShipped(row: Pick<FeedEventRow, "event_type" | "severity">): boolean {
  const sev = (row.severity || "").toLowerCase();
  if (sev === "error" || sev === "critical") return false;
  return SHIPPED_TYPE.test(row.event_type || "");
}

export type FeedViewerScope = {
  /** capabilities.canSeeSystemSurfaces — the tape's audience since it lived on /operations. */
  canSeeTape: boolean;
  /** capabilities.canSeeCompanyFinancials. */
  canSeeCompanyFinancials: boolean;
  /** Departments the viewer's rail draws (mayOpenOsHref over OS_DEPARTMENTS). */
  departments: ReadonlySet<DepartmentKey>;
};

/** The rows this viewer may see, in the order given. */
export function visibleFeedRows<T extends FeedEventRow>(rows: readonly T[], scope: FeedViewerScope): T[] {
  if (!scope.canSeeTape) return [];
  return rows.filter((row) => {
    const dept = departmentForEvent(row);
    if (dept && !scope.departments.has(dept)) return false;
    if (!scope.canSeeCompanyFinancials && (dept === "finance" || carriesMoney(row))) return false;
    return true;
  });
}

/** Tab from ?tab=. Viewers without the tape only have Needs you. */
export function parseFeedTab(raw: unknown, canSeeTape: boolean): FeedTab {
  if (!canSeeTape) return "needs";
  const v = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (v === "needs" || v === "shipped" || v === "all") return v;
  // Default: All. The page opens on Needs you instead when approvals are
  // waiting (app/feed/page.tsx): a Feed that opens on an empty tab reads as a
  // broken one, and one that hides a waiting approval behind a tab is worse.
  return "all";
}

/** Department filter from ?dept=<slug or key>, only among those the viewer may open. */
export function parseFeedDepartment(
  raw: unknown,
  options: ReadonlyArray<{ key: DepartmentKey; slug: string }>,
): DepartmentKey | null {
  const v = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (!v) return null;
  return options.find((d) => d.slug === v || d.key === v)?.key ?? null;
}

export function rowsForTab<T extends FeedEventRow>(rows: readonly T[], tab: FeedTab, dept: DepartmentKey | null): T[] {
  if (tab === "needs") return [];
  return rows.filter((r) => (tab === "shipped" ? isShipped(r) : true) && (!dept || departmentForEvent(r) === dept));
}
