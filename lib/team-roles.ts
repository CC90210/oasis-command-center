/**
 * team-roles — the role enum and the invite menu, in one dependency-free module.
 *
 * WHY THIS IS SEPARATE FROM lib/team.ts
 * lib/team.ts imports node:crypto and the Supabase server client. A "use client"
 * component importing the role list from there would drag that whole server
 * chain into the browser bundle. So the two things a client legitimately needs —
 * the role names and their labels — live here, with no imports at all.
 *
 * Same discipline as lib/role-surfaces.ts: pure by design, unit-testable without
 * a database, and safe to import from either side of the server/client boundary.
 *
 * WHAT THIS FIXES
 * The invite menu was hand-typed a SECOND time in app/team/TeamInviteActions.tsx.
 * Two lists with no link between them: a role added to the API allowlist could
 * not be offered by the dropdown, and a role dropped from the dropdown was still
 * accepted by the API. Neither half fails loudly — they just quietly disagree.
 * This is now the one list both sides read.
 */

export type TeamRole =
  // Platform roles. Meaningful in every workspace.
  | "owner"
  | "admin"
  | "read_only"
  // OASIS sales org (2026-08-21). Job titles, not permission tiers: the role IS
  // the job, so the nav a person gets and the rate they are paid both derive
  // from this one field rather than a second lookup that can disagree with it.
  | "manager"
  | "closer"
  | "opener"
  | "builder"
  // Marketing staff (2026-08-21). Content, campaigns and the founders
  // marketing studio — never revenue, never the sales pipeline.
  | "marketing"
  // Legacy. Still resolvable because live rows carry them (43 `member`, and
  // `member` is the column DEFAULT), but no longer offered on the invite menu —
  // "member" and "agent" are the ambiguous pair the job titles above replace.
  | "agent"
  | "member"
  // SunBiz's own roles. A different portal; not ours to change.
  | "loan_officer"
  | "processor";

/** A role an admin may hand out through the invite UI. `owner` is never invitable. */
export type InvitableRole = Exclude<TeamRole, "owner">;

export type RoleOption = {
  value: InvitableRole;
  label: string;
  /** One plain-English sentence shown beside the selector. */
  description: string;
};

/**
 * Roles offered in EVERY workspace. Infrastructure, not product.
 */
export const PLATFORM_ROLE_OPTIONS: ReadonlyArray<RoleOption> = [
  {
    value: "member",
    label: "Team member",
    description: "Internal workspace access without sales-management or permanent admin powers.",
  },
  {
    value: "admin",
    label: "Administrator",
    description: "Full workspace and team administration; only a permanent admin can grant this role.",
  },
];

/**
 * Roles offered ONLY in an OASIS-owned workspace.
 *
 * These are a PRODUCT concern, not infrastructure, and CONTEXT.md's rule is that
 * product features do not extrapolate across tenants. A SunBiz admin has no use
 * for "Closer", and someone invited as a closer onto a SunBiz tenant would get a
 * persona built for a workspace they are not standing in.
 *
 * NAME NOTE: this now carries `marketing` as well, which is not a sales role.
 * The list is "roles that exist only inside OASIS", and the SALES_ in the name
 * is a leftover from when that was the same thing. Left as-is on purpose — the
 * identifier is load-bearing across team-roles, role-surfaces and the invite
 * API, and renaming it to correct a comment is a wide change for zero
 * behavioural gain. `isOasisSalesRole` gates tenant eligibility, and marketing
 * belongs in that gate for exactly the same reason a closer does.
 */
export const OASIS_SALES_ROLE_OPTIONS: ReadonlyArray<RoleOption> = [
  {
    value: "manager",
    label: "Sales manager",
    description: "Reviews every rep's assigned sales book and team performance, but edits only their own leads.",
  },
  {
    value: "closer",
    label: "Closer",
    description: "Works assigned deals from booked meeting through close and sees only their own book.",
  },
  {
    value: "opener",
    label: "Opener",
    description: "Works assigned leads through qualification and handoff without pricing or closing powers.",
  },
  {
    value: "builder",
    label: "Builder",
    description: "Works assigned delivery and selling records without tenant-wide administration.",
  },
  {
    value: "marketing",
    label: "Marketing",
    description: "Uses OASIS marketing tools without company finance or system-administration access.",
  },
];

/** Human labels for existing rows, including roles that are no longer invitable. */
export const TEAM_ROLE_LABELS: Readonly<Record<TeamRole, string>> = {
  owner: "Owner",
  admin: "Administrator",
  read_only: "Read only",
  manager: "Sales manager",
  closer: "Closer",
  opener: "Opener",
  builder: "Builder",
  marketing: "Marketing",
  agent: "Sales rep (legacy)",
  member: "Team member",
  loan_officer: "Loan officer",
  processor: "Processor",
};

/** Render a stored role without leaking raw enum syntax into the product UI. */
export function teamRoleLabel(role: TeamRole | string | null | undefined): string {
  const normalized = (role || "").trim().toLowerCase() as TeamRole;
  return TEAM_ROLE_LABELS[normalized] || "Unknown role";
}

/**
 * People whose assigned OASIS records make up a sales manager's read-only
 * team book. This deliberately excludes owner/admin/member/read_only: their
 * assigned records are founder, internal, or system work rather than a rep's
 * sales book. Marketing is deliberately included per CC's 2026-08-26 update:
 * they may work only records assigned to them, and the sales manager must be
 * able to coach that book. Legacy `agent` stays until its live rows migrate.
 */
export const OASIS_PIPELINE_REP_ROLES: ReadonlySet<string> = new Set([
  "manager",
  "closer",
  "opener",
  "builder",
  "marketing",
  "agent",
]);

export function isOasisPipelineRepRole(role: unknown): boolean {
  return (
    typeof role === "string" &&
    OASIS_PIPELINE_REP_ROLES.has(role.trim().toLowerCase())
  );
}

/** The OASIS sales job titles, as a set — used to decide tenant eligibility. */
export const OASIS_SALES_ROLES: ReadonlySet<string> = new Set(
  OASIS_SALES_ROLE_OPTIONS.map((o) => o.value),
);

/** True when `role` is one of the OASIS sales job titles. */
export function isOasisSalesRole(role: unknown): boolean {
  return typeof role === "string" && OASIS_SALES_ROLES.has(role);
}

/**
 * ============================================================================
 * WHO IS A REP, AND WHICH REPS MAY TOUCH MONEY
 * ============================================================================
 *
 * Added 2026-08-24, and it closes a gap the 2026-08-21 job-title change opened.
 *
 * THE BACKGROUND. `agent` is the LEGACY commission-only contractor role. It was
 * replaced by the job titles above -- `opener` and `closer` -- but two pieces of
 * code that gate real behaviour were never moved across, and both still ask
 * `teamRole === "agent"` and nothing else:
 *
 *   1. lead scoping (lib/web-leads/data.ts, the manifest records route)
 *   2. who may quote and close (the website-sales rep-action route)
 *
 * The consequences were opposite and both wrong. A rep invited as `opener` or
 * `closer` -- which is what the invite menu actually offers -- was NOT scoped to
 * their own book, so they could read every lead in the tenant, reopening exactly
 * the leak PR #237 closed for `agent`. And the same rep could not quote or close
 * ANYTHING, so the role literally named "Closer" could not close.
 *
 * THE OPERATOR REQUIREMENT (Adon, 2026-08-24): "it shouldn't change what reps
 * can do, but you should be able to establish openers and closers, because
 * although it's starting off with some people doing both, we're going to grow to
 * the point that there are positions specifically for certain people and the
 * software should be able to accommodate that."
 *
 * So: `agent` keeps everything it has today (nobody's access changes), `closer`
 * gains what its name promises, and `opener` becomes a real setter-only seat
 * that can work a book and hand it off but cannot put a price in front of a
 * prospect. No migration is needed -- these roles already exist and the invite
 * menu already offers them.
 */

/**
 * Roles that are scoped to their OWN records and must never see the tenant's
 * whole book.
 *
 * A tenant check alone does not stop these people: they sit fully INSIDE the
 * tenant. This is the predicate that keeps a contractor from pulling all ~31K
 * web-sales leads, and every door onto tenant_records must apply it identically
 * or the leak simply moves to whichever door forgot.
 *
 * `builder` is included deliberately. They are not a sales role at all, and
 * being MORE scoped than necessary is the safe direction to be wrong in.
 */
export const SELF_SCOPED_ROLES: ReadonlySet<string> = new Set([
  "agent",   // legacy contractor, still live on real rows
  // Cross-rep manager visibility exists only on the dedicated OASIS pipeline.
  // Generic tenant-record doors stay own-only so they cannot expose
  // unassigned, founder, or system records.
  "manager",
  "opener",
  "closer",
  "builder",
  "marketing",
]);

/** True when this role is a KNOWN self-scoped role. This answers set membership
 *  and nothing more — for the security question, use `mustSeeOwnRecordsOnly`. */
export function isSelfScopedRole(role: unknown): boolean {
  return typeof role === "string" && SELF_SCOPED_ROLES.has(role.trim().toLowerCase());
}

/**
 * Roles explicitly TRUSTED with the whole tenant's records.
 *
 * Added 2026-08-24 after an independent review caught that the scoping gate was
 * fail-OPEN on an unrecognised role.
 *
 * `mustScopeRegardlessOfFlag` returns `!isAdmin && <role predicate>`, and the
 * route scopes when `leadScopingEnabled() || mustScopeRegardlessOfFlag(...)`.
 * `LEAD_SCOPING_ENABLED` defaults OFF. So a role the predicate does not
 * recognise produced `false`, the OR collapsed to false, and the request was
 * served UNSCOPED — the whole tenant, which is the exact leak this gate exists
 * to stop. Deny-by-default has to be expressed as an allowlist of who may see
 * everything, never as a denylist of who may not.
 *
 * `manager` is deliberately absent. A manager's cross-rep visibility is a
 * narrower OASIS sales capability: assigned rows for known rep roles only.
 * Treating the title as tenant-wide here also exposed unassigned, founder and
 * system records through generic manifest endpoints. Their dedicated pipeline
 * reader widens READ only; every generic door and every write stays own-only.
 *
 * `closer`, `opener` and `builder` were added here on 2026-08-26 by 01461615
 * ("enable lead access and cross-role transfers...") and are removed again. All
 * three are members of SELF_SCOPED_ROLES above, so listing them here put them in
 * BOTH sets — the overlap tests/agent-api-scope.test.ts forbids, because it makes
 * the answer depend on which door a request happens to knock on. Concretely it
 * reopened the leak #285 closed: `mustSeeOwnRecordsOnly` is the predicate at every
 * door onto tenant_records, so an opener stopped being confined and could read the
 * whole ~31K web-sales book. Working your OWN book — what 01461615 set out to
 * enable — runs through the per-lead ownership predicates, never a seat here.
 */
export const TENANT_WIDE_ROLES: ReadonlySet<string> = new Set([
  "owner",
  "admin",
  "read_only",
  "member",        // legacy, and the column DEFAULT — 45 live rows
  "loan_officer",  // SunBiz's own portal roles; a different product
  "processor",
]);

/**
 * The security question: must this person be confined to their own records?
 *
 * Fail-closed complement of `isSelfScopedRole`. Anything not explicitly on the
 * tenant-wide allowlist is confined, including an unrecognised or malformed
 * value. Admins are exempt and every caller checks that separately, so this
 * stays a pure role question.
 *
 * Use THIS at every door onto tenant_records. `isSelfScopedRole` answers a
 * narrower question and is fail-open by construction.
 */
export function mustSeeOwnRecordsOnly(role: unknown): boolean {
  if (typeof role !== "string") return true;
  return !TENANT_WIDE_ROLES.has(role.trim().toLowerCase());
}

/**
 * Roles that may put a PRICE in front of a prospect: build a proposal and close
 * a deal on their own book.
 *
 * `opener` is deliberately absent, and that absence is the whole feature. A
 * setter qualifies and hands off; letting one quote means a new rep discounts
 * on their first week, promises a delivery date nobody agreed to, or confirms a
 * custom build is feasible when it is not. Those are the exact things the offer
 * doctrine forbids a setter from doing.
 *
 * `agent` IS present. That is not an oversight and not laziness: it is the
 * legacy role every current rep actually carries, it can quote and close today,
 * and the operator's instruction was explicitly that this change must not take
 * anything away from the people already working. New seats get the precise
 * title; existing seats keep working. Migrate a person by changing their role,
 * which is a deliberate act with a visible audit trail, not a silent revocation
 * they discover mid-call.
 */
export const DEAL_CLOSING_ROLES: ReadonlySet<string> = new Set([
  // A manager may be selected as the audit host. Once the booking assigns the
  // lead to them, they need the same own-lead completion/exception path as a
  // closer. Every caller still proves assignment/collaboration separately.
  "manager",
  "closer",
  "agent",   // legacy, and grandfathered ON PURPOSE -- see above
  // CC, 2026-08-25: the builder/marketing specialist also sells, so he quotes
  // and closes his OWN book like a closer. Ownership is still enforced at
  // every call site; this set only answers the role half. There is one live
  // builder (schneur@oasisai.work) and this widening is deliberate for the
  // seat, not a one-off account patch.
  "builder",
]);

/**
 * May this role quote and close on a lead it owns?
 *
 * This answers the ROLE question only. Every caller must still confirm the lead
 * actually belongs to this person -- ownership is not a role property, and a
 * closer may no more close someone else's deal than an opener may close their
 * own. Fails closed on anything unrecognised.
 */
export function mayQuoteAndClose(role: unknown): boolean {
  return typeof role === "string" && DEAL_CLOSING_ROLES.has(role.trim().toLowerCase());
}

/**
 * Roles eligible to HOST a booked 15-minute audit call.
 *
 * Widened 2026-08-25 (operator plan): the old inline allowlist was
 * `is_owner || owner|admin|closer`, so newly added reps and the selling
 * builder never appeared in the "Founder or closer hosting" dropdown and the
 * API refused them server-side. Hosting is RUNNING the booked call — it is
 * not a quote/close grant (that stays DEAL_CLOSING_ROLES) and not a
 * commission change (attribution still freezes on booking).
 *
 * `agent` is grandfathered for the same reason it sits in DEAL_CLOSING_ROLES,
 * and `marketing` is included per the operator's explicit instruction even
 * though no live marketing row exists yet — hosting ≠ revenue ownership.
 */
export const AUDIT_HOST_ROLES: ReadonlySet<string> = new Set([
  "owner",
  "admin",
  "manager",
  "closer",
  "agent",     // legacy full-stack rep, kept working on purpose
  "builder",   // CC 2026-08-25: the selling builder hosts his own audits
  "marketing",
]);

/** True when this role may host a booked audit call. Fails closed. */
export function mayHostAuditCall(role: unknown): boolean {
  return typeof role === "string" && AUDIT_HOST_ROLES.has(role.trim().toLowerCase());
}

/**
 * Every role the invite UI can offer ANYWHERE. This is the "is it a role at
 * all" set — it deliberately does NOT answer "may it be used here", which is
 * tenant-dependent and lives in lib/role-surfaces.ts.
 */
export const INVITABLE_ROLE_OPTIONS: ReadonlyArray<RoleOption> = [
  ...PLATFORM_ROLE_OPTIONS,
  ...OASIS_SALES_ROLE_OPTIONS,
];

/** Just the values — the first gate an inbound role passes. */
export const INVITABLE_ROLES: InvitableRole[] = INVITABLE_ROLE_OPTIONS.map((o) => o.value);

/**
 * Type guard for an UNTRUSTED inbound role string (request body, query param).
 * Allowlist by construction: an unrecognised value is not a role.
 */
export function isInvitableRole(value: unknown): value is InvitableRole {
  return typeof value === "string" && (INVITABLE_ROLES as string[]).includes(value);
}
