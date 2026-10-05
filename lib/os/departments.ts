/**
 * lib/os/departments.ts — the v1 department list (plan D3), declared once.
 *
 * The rail's Departments group is generated from this list (lib/os/nav.ts), so
 * a department page (`app/team/[dept]`) and the rail can never disagree about
 * which departments exist, what they are called, or who may open them. A page
 * gate should resolve its slug here and then ask `mayOpenOsHref` in
 * lib/os/nav.ts — the same predicate the rail used to decide whether to draw
 * the row.
 *
 * Legal, Content and Research are opt-in modules in the design and are not
 * listed until a page exists for them: a row over a missing page is a dead tab.
 */

import type { DepartmentKey, ModuleKey, OsAudience } from "@/lib/os/types";

export type OsDepartment = {
  key: DepartmentKey;
  /** URL segment under /team/. */
  slug: string;
  label: string;
  href: string;
  module?: ModuleKey;
  audience: OsAudience;
};

export const OS_DEPARTMENTS: readonly OsDepartment[] = [
  // Always on. Chief of Staff is also the target of the Ask button (plan D2).
  { key: "chief_of_staff", slug: "chief-of-staff", label: "Chief of Staff", href: "/team/chief-of-staff", audience: "everyone" },
  { key: "sales", slug: "sales", label: "Sales", href: "/team/sales", audience: "everyone" },
  { key: "marketing", slug: "marketing", label: "Marketing", href: "/team/marketing", audience: "everyone" },
  // Client Success works projects, tickets and client health — the delivery
  // data lib/delivery/access.ts keeps founder-only inside OASIS. Same rule here.
  { key: "client_success", slug: "client-success", label: "Client Success", href: "/team/client-success", audience: "delivery" },
  // Owner-gated. Finance reads company money, so it takes the money flag, and
  // the `finance` module keeps it off every workspace whose fin_* rows are not
  // tenant-scoped yet (today: every workspace but OASIS).
  { key: "finance", slug: "finance", label: "Finance", href: "/team/finance", module: "finance", audience: "company_financials" },
  { key: "operations", slug: "operations", label: "Operations", href: "/team/operations", audience: "manage" },
];

/** The department behind a /team/<slug> URL, or null. Case-insensitive. */
export function departmentBySlug(slug: string | null | undefined): OsDepartment | null {
  const s = (slug || "").trim().toLowerCase();
  return OS_DEPARTMENTS.find((d) => d.slug === s) ?? null;
}
