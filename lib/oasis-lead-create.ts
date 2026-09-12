/**
 * Adding an OASIS lead by hand: which stages a person may start one in, and
 * what the server stamps on it.
 *
 * ONE module, called by BOTH create doors -- POST
 * /api/manifest/<slug>/records/lead (the /pipeline/new form) and POST
 * /api/leads/quick-add on an OASIS workspace -- and read by the form itself,
 * so the picker, the server and the board cannot disagree again.
 *
 * WHY THIS EXISTS (CC, 2026-09-10): "It only allows me to add a lead to the
 * research section, which isn't even a section. Once I add the lead, it says
 * Redirecting, and then it takes me back to the pipeline, where the lead does
 * not exist ... I tried to put the stage as founder meeting, and it said that
 * I can't do it." Three lists had drifted apart:
 *
 *   the form picker   all 14 stages (the seed enum)
 *   the server        accepted exactly one: `researched`
 *   the board         stopped drawing `researched` on 2026-08-21
 *
 * The one stage the server accepted was the one stage the board no longer
 * drew. And an admin create got no owner and no `sales_motion`, while /pipeline
 * filters on `sales_motion = cold_outbound` and /web-leads needs an owner for
 * My leads -- so even that lead existed in the database and on no screen.
 *
 * So the board stages, the creatable stages and the stamp live here, and
 * tests/oasis-create-stage-contract.test.ts pins them to each other and to the
 * admin set_stage list (WEBSITE_SALES_STAGES in lib/website-sales.ts).
 */

import { OASIS_LEAD_STAGES, type StageMeta } from "@/lib/oasis-stage-meta";
import {
  OASIS_WEBSITE_SALES_PROGRAM,
  rejectedOasisGenericPatchKeys,
  stagesForOasisRole,
} from "@/lib/oasis-sales-pipeline-policy";
import {
  OASIS_COLD_OUTBOUND_MOTION,
  OASIS_INTAKE_STAGE,
  isWebsiteSalesTenantSlug,
} from "@/lib/leads/canonical-lead-fields";
import {
  OASIS_WEBSITE_TENANT_SLUG,
  mayWorkWebsiteSalesLifecycle,
} from "@/lib/website-sales-workflow";
import { CA_REGIONS, countryOf } from "@/lib/web-leads/filters";
import { US_STATE_CODES } from "@/lib/address/us-address";
import { humanize } from "@/lib/manifest/humanize";
import type { ManifestEntityDef, ManifestEntityField } from "@/lib/manifest/schema";

/**
 * The unclaimed prospect pool. Not a pipeline stage: the board hides it
 * (app/pipeline/page.tsx) and /web-leads serves it as the claimable pool. A
 * hand-made lead has no territory, so it could never be found there -- which
 * is why no one may create into it.
 */
export const OASIS_POOL_STAGE = OASIS_INTAKE_STAGE;

/** The stage every creator may use, and the one a request without a stage gets. */
export const OASIS_DEFAULT_CREATE_STAGE = "assigned";

/** The lead field that places a lead on the Canada or the US board. */
export const OASIS_LEAD_REGION_FIELD = "state";

/**
 * How the create form labels that field. The key stays `state` -- every lead,
 * filter and board read uses it -- but its options include Canadian provinces,
 * and a required field called "State" reads as US-only to a team working the
 * Canada board.
 */
export const OASIS_LEAD_REGION_LABEL = "Province / State";

export type OasisCreateViewer = {
  /**
   * The capability-admin predicate admin set_stage uses (owner, admin, or the
   * admin_access toggle) -- session.isAdmin / isAdminProfile(). NOT
   * isOasisPipelineAdmin, which also admits `member`: that is a visibility
   * rule, and `member` is the team_role column default, not a sales seat.
   */
  isAdmin: boolean;
  teamRole: string | null | undefined;
};

/**
 * The stages the OASIS board draws for this viewer: every lifecycle stage the
 * role may see, minus the prospect pool. app/pipeline/page.tsx renders exactly
 * this list, and the creatable list below is carved out of it, so a lead can
 * never be created into a column its creator's board does not have.
 */
export function oasisBoardStages(viewer: {
  teamRole: string | null | undefined;
  isOwner?: boolean;
  adminAccess?: boolean;
}): StageMeta[] {
  return stagesForOasisRole(
    viewer.teamRole || "",
    Boolean(viewer.isOwner),
    Boolean(viewer.adminAccess),
  ).filter((stage) => stage.key !== OASIS_POOL_STAGE);
}

/**
 * Which stages this viewer may create a lead in.
 *
 *   admin        every stage their board draws (13 today) -- CC's ask
 *   sales role   `assigned` only; moving a lead further is the guided
 *                lifecycle's job, and direct stage moves are admin-only
 *                (set_stage) for the same reason
 *   anyone else  nothing
 *
 * Fails closed: an unknown role, or a role whose board lacks `assigned`,
 * creates nothing.
 */
export function creatableOasisStages(viewer: OasisCreateViewer): StageMeta[] {
  const role = (viewer.teamRole || "").trim().toLowerCase();
  if (viewer.isAdmin) {
    // A capability admin is always a pipeline admin (owner/admin/admin_access
    // are all in isOasisPipelineAdmin), so their board is every stage. Passing
    // isOwner routes them through the same function the board uses rather than
    // a second hand-written list.
    return oasisBoardStages({ teamRole: role, isOwner: true });
  }
  if (!mayWorkWebsiteSalesLifecycle(role)) return [];
  return oasisBoardStages({ teamRole: role }).filter(
    (stage) => stage.key === OASIS_DEFAULT_CREATE_STAGE,
  );
}

/**
 * Region codes a lead may carry: Canadian provinces and territories, then US
 * states and territories. /web-leads puts a lead on the CA or the US board by
 * this code (countryOf), and that split is a legal line -- CASL on one side,
 * TCPA/DNC on the other -- so a hand-made lead must name one.
 */
export const OASIS_LEAD_REGION_CODES: readonly string[] = [...CA_REGIONS, ...US_STATE_CODES];

const REGION_CODE_SET = new Set(OASIS_LEAD_REGION_CODES);

/** The canonical region code for `raw`, or null when it is not one. */
export function normalizeOasisLeadRegion(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const code = raw.trim().toUpperCase();
  return REGION_CODE_SET.has(code) ? code : null;
}

/** "ON - Canada" / "FL - United States": the board the code will put a lead on. */
export function oasisRegionLabel(code: string): string {
  return `${code} - ${countryOf(code) === "ca" ? "Canada" : "United States"}`;
}

/**
 * The server-owned fields every OASIS create carries, admin or rep.
 *
 *   sales_motion      the /pipeline filter (lib/oasis-pipeline-query.ts)
 *   sales_program     the oasis-webdev board's program predicate
 *   assigned_to       the creator, lowercased: every "is this in my book"
 *                     check (lead-scope, web-leads isInBookOf, the rep
 *                     pipeline read) compares a lowercased id
 *   assigned_at, stage_entered_at   now
 *   lost_at           now, only for a lead created as lost
 *
 * `claimed_at` is deliberately NOT set. A claim with no timestamp reads as
 * held (lib/web-leads/claim.ts availability()), so a lead someone typed in by
 * hand is never released back to the pool by the 7-day stale-claim rule.
 */
export function oasisLeadCreateStamp(input: {
  stage: string;
  creatorUserId: string;
  now: Date;
}): Record<string, unknown> {
  const at = input.now.toISOString();
  return {
    stage: input.stage,
    stage_entered_at: at,
    sales_program: OASIS_WEBSITE_SALES_PROGRAM,
    sales_motion: OASIS_COLD_OUTBOUND_MOTION,
    assigned_to: input.creatorUserId.trim().toLowerCase(),
    assigned_at: at,
    ...(input.stage === "lost" ? { lost_at: at } : {}),
  };
}

export type OasisStageChoice = { key: string; label: string };

export type OasisLeadCreateRefusal = {
  ok: false;
  status: 403 | 409 | 422;
  error:
    | "no_identity"
    | "forbidden_role"
    | "protected_lifecycle_fields"
    | "stage_not_creatable"
    | "region_required"
    | "invalid_region";
  /** A sentence a person can act on. The form shows this, never `error`. */
  message: string;
  fields?: string[];
  allowedStages?: OasisStageChoice[];
};

export type OasisLeadCreatePlan =
  | { ok: true; stage: string; data: Record<string, unknown> }
  | OasisLeadCreateRefusal;

/**
 * The refusal for a role that may add no OASIS lead at all. Shared by the
 * planner and by quick-add's existing-lead branch, so both doors say the
 * same thing.
 */
export function oasisForbiddenRoleRefusal(): OasisLeadCreateRefusal {
  return {
    ok: false,
    status: 403,
    error: "forbidden_role",
    message:
      "Your role can't add leads to the OASIS pipeline. Ask an admin to add it, or to give you a sales role.",
  };
}

/**
 * Claim facts a create may not carry. A `claimed_at` in the past, on a lead
 * nobody has dialled, reads as claim_expired and releases a hand-made lead
 * to the pool, which is exactly what the stamp's missing claimed_at exists to
 * prevent; with a territory id the lead also lands in the claimable pool.
 * The claim flow sets both. A create form never does.
 */
export const OASIS_CREATE_REFUSED_FIELDS: ReadonlySet<string> = new Set([
  "claimed_at",
  "webdev_territory_id",
]);

function listNames(names: string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function stageRefusal(
  requested: string,
  allowed: StageMeta[],
  isAdmin: boolean,
): OasisLeadCreateRefusal {
  const shown = requested.slice(0, 60);
  const known = OASIS_LEAD_STAGES.find((stage) => stage.key === requested);
  const labels = allowed.map((stage) => stage.label);
  let lead: string;
  if (!known) {
    lead = `"${shown}" isn't a stage on the OASIS pipeline.`;
  } else if (known.key === OASIS_POOL_STAGE) {
    lead = `${known.label} is the unclaimed prospect pool in Leads, not a pipeline stage, so a lead you add can't start there.`;
  } else {
    lead = `A lead you add can't start in ${known.label}.`;
  }
  const choice =
    labels.length === 1
      ? `New leads you add start in ${labels[0]}.`
      : `Pick one of: ${labels.join(", ")}.`;
  const escalation = isAdmin ? "" : " An admin can move it further along once it's added.";
  return {
    ok: false,
    status: 409,
    error: "stage_not_creatable",
    message: `${lead} ${choice}${escalation}`,
    allowedStages: allowed.map((stage) => ({ key: stage.key, label: stage.label })),
  };
}

/**
 * Decide an OASIS create and build the row to write -- or refuse it with a
 * sentence the person can act on. Pure: never mutates `data`, never touches a
 * database. The route writes `plan.data` as-is.
 *
 * `requireRegion` is set by both OASIS create doors: the records route (the
 * form requires Province / State) and quick-add, which refuses a new OASIS
 * lead without `state`. Left unset, a region is checked only when one is sent.
 */
export function planOasisLeadCreate(input: {
  viewer: OasisCreateViewer;
  creatorUserId: string;
  data: Record<string, unknown>;
  now: Date;
  requireRegion?: boolean;
}): OasisLeadCreatePlan {
  const creator = (input.creatorUserId || "").trim();
  if (!creator) {
    return {
      ok: false,
      status: 403,
      error: "no_identity",
      message: "We couldn't tell who is adding this lead, so it wasn't saved. Sign in again and retry.",
    };
  }

  const allowed = creatableOasisStages(input.viewer);
  if (allowed.length === 0) return oasisForbiddenRoleRefusal();

  const data = input.data;
  // stage is chosen below; sales_program is accepted only as the exact value
  // the server stamps anyway. Everything else in the lifecycle set moves only
  // through its audited route, never through a create form.
  const fields = rejectedOasisGenericPatchKeys(data).filter(
    (key) => key !== "stage" && key !== "sales_program",
  );
  for (const key of Array.from(OASIS_CREATE_REFUSED_FIELDS)) {
    const value = data[key];
    if (value !== undefined && value !== null && value !== "" && !fields.includes(key)) {
      fields.push(key);
    }
  }
  if (data.sales_program !== undefined && data.sales_program !== OASIS_WEBSITE_SALES_PROGRAM) {
    fields.push("sales_program");
  }
  if (fields.length > 0) {
    const names = fields.map((field) => humanize(field));
    return {
      ok: false,
      status: 409,
      error: "protected_lifecycle_fields",
      fields,
      message: `${listNames(names)} ${fields.length === 1 ? "is" : "are"} set by the pipeline itself, not typed into a new lead. Clear ${fields.length === 1 ? "it" : "them"} and save again.`,
    };
  }

  const rawStage = data.stage;
  const requested =
    rawStage === undefined || rawStage === null || (typeof rawStage === "string" && !rawStage.trim())
      ? OASIS_DEFAULT_CREATE_STAGE
      : String(rawStage).trim();
  if (!allowed.some((stage) => stage.key === requested)) {
    return stageRefusal(requested, allowed, input.viewer.isAdmin);
  }

  const rawRegion = data[OASIS_LEAD_REGION_FIELD];
  const regionGiven = typeof rawRegion === "string" ? rawRegion.trim() !== "" : rawRegion != null;
  const region = normalizeOasisLeadRegion(rawRegion);
  if (regionGiven && !region) {
    return {
      ok: false,
      status: 422,
      error: "invalid_region",
      fields: [OASIS_LEAD_REGION_FIELD],
      message: `"${String(rawRegion).slice(0, 40)}" isn't a Canadian province or US state code. Pick one from the list, like ON or FL.`,
    };
  }
  if (!region && input.requireRegion) {
    return {
      ok: false,
      status: 422,
      error: "region_required",
      fields: [OASIS_LEAD_REGION_FIELD],
      message:
        "Pick the province or state this business is in. It decides whether the lead is worked on the Canada or the US board, and the two run under different calling laws.",
    };
  }

  return {
    ok: true,
    stage: requested,
    data: {
      ...data,
      ...(region ? { [OASIS_LEAD_REGION_FIELD]: region } : {}),
      ...oasisLeadCreateStamp({ stage: requested, creatorUserId: creator, now: input.now }),
    },
  };
}

export type OasisLeadCreateForm = {
  /** The seed lead entity, trimmed to what this viewer's create is allowed to send. */
  entity: ManifestEntityDef;
  /** Option labels for enum fields, keyed by field name then option value. */
  optionLabels: Record<string, Record<string, string>>;
  /** Field labels that differ from the humanized key, keyed by field name. */
  fieldLabels: Record<string, string>;
  stages: StageMeta[];
};

/**
 * What the /pipeline/new form asks for: what a person adding a lead knows and
 * types. Shown in the seed's order.
 *
 * An ALLOW-list, not the seed minus a deny-list. The seed lead also carries
 * fields the pipeline fills in itself -- score, value_estimate, the site audit
 * (website_condition, audit_findings) and the ai_* fields the scoring and
 * next-action jobs write. Trimming only the lifecycle set left all ten on the
 * form as empty boxes labelled "Ai Score" and "Ai Next Action At" (portal
 * audit, 2026-09-11). The lead itself still carries them; a new lead just
 * doesn't ask for them.
 */
export const OASIS_LEAD_CREATE_FIELDS: readonly string[] = [
  "name",
  "company",
  "email",
  "phone",
  "website",
  "industry",
  "business_city",
  OASIS_LEAD_REGION_FIELD,
  "source",
  "stage",
  "notes",
];

const CREATE_FIELD_SET = new Set(OASIS_LEAD_CREATE_FIELDS);

/**
 * The /pipeline/new form for this viewer.
 *
 * A trimmed COPY of the seed lead entity, never an edit of it: existing
 * researched leads and the edit form still rely on the seed's full 14-stage
 * enum. The copy offers only OASIS_LEAD_CREATE_FIELDS, with
 *   - stage: exactly creatableOasisStages(viewer), labelled as the board
 *     labels them ("Founder Meeting", not "Founder Meeting Booked")
 *   - state: required, a region code, labelled "Province / State"
 * Every field it offers is one the server accepts on create: a picker must
 * offer only what the server accepts.
 */
export function oasisLeadCreateForm(
  seedLead: ManifestEntityDef,
  viewer: OasisCreateViewer,
): OasisLeadCreateForm {
  const stages = creatableOasisStages(viewer);
  const regionField: ManifestEntityField = {
    name: OASIS_LEAD_REGION_FIELD,
    type: "enum",
    required: true,
    enum_values: [...OASIS_LEAD_REGION_CODES],
  };
  const fields: ManifestEntityField[] = [];
  let sawRegion = false;
  for (const field of seedLead.fields) {
    if (field.name === "stage") {
      fields.push({ ...field, type: "enum", required: true, enum_values: stages.map((stage) => stage.key) });
    } else if (field.name === OASIS_LEAD_REGION_FIELD) {
      sawRegion = true;
      fields.push({ ...field, ...regionField });
    } else if (CREATE_FIELD_SET.has(field.name)) {
      fields.push({ ...field });
    }
  }
  if (!sawRegion) fields.push(regionField);
  return {
    entity: { ...seedLead, fields },
    optionLabels: {
      stage: Object.fromEntries(stages.map((stage) => [stage.key, stage.label])),
      [OASIS_LEAD_REGION_FIELD]: Object.fromEntries(
        OASIS_LEAD_REGION_CODES.map((code) => [code, oasisRegionLabel(code)]),
      ),
    },
    fieldLabels: { [OASIS_LEAD_REGION_FIELD]: OASIS_LEAD_REGION_LABEL },
    stages,
  };
}

/** /pipeline/new?stage=<key>: honoured when this viewer may create there, else the default. */
export function preselectOasisCreateStage(
  requested: unknown,
  stages: readonly StageMeta[],
): string | null {
  const want = typeof requested === "string" ? requested.trim() : "";
  if (want && stages.some((stage) => stage.key === want)) return want;
  if (stages.some((stage) => stage.key === OASIS_DEFAULT_CREATE_STAGE)) {
    return OASIS_DEFAULT_CREATE_STAGE;
  }
  return stages[0]?.key ?? null;
}

/**
 * EVERY OASIS LEAD CREATE URL OPENS /pipeline/new -- the one create form.
 *
 * The /t/<slug> catch-all also answers a "new record" URL
 * (/t/oasis-ai-cc/leads/new, and the manifest kanban's New button). There it
 * rendered the SEED lead entity: all 14 stages including the prospect pool, a
 * free-text State and last_contacted_at -- three things the records route
 * refuses. The catch-all sent only nine named roles to /pipeline, so any other
 * profile (an is_owner row with no team_role, a read_only seat) got that second
 * picker: the defect CC reported, on another URL (review, 2026-09-10).
 *
 * Role-blind on purpose: /pipeline/new builds its picker from
 * creatableOasisStages and sends a role that may create nothing to /pipeline.
 * `?stage=` is carried, encoded, so a column's "+" keeps its stage.
 *
 * Returns the target, or null when the URL is not an OASIS lead create --
 * SunBiz and every other tenant keep their own form.
 */
export function oasisLeadCreateRedirect(input: {
  tenantSlug: string | null | undefined;
  entity: string | null | undefined;
  isNewForm: boolean;
  stage?: string | null;
}): string | null {
  if (!input.isNewForm || input.entity !== "lead" || !isWebsiteSalesTenantSlug(input.tenantSlug)) {
    return null;
  }
  const stage = typeof input.stage === "string" ? input.stage.trim() : "";
  return stage ? `/pipeline/new?stage=${encodeURIComponent(stage)}` : "/pipeline/new";
}

/**
 * The program/motion predicate the OASIS board applies for a tenant. Lives
 * beside the stamp because the stamp must satisfy it: app/pipeline/page.tsx
 * passes exactly this to listOasisPipelineWindow, and the contract test proves
 * a stamped lead passes it on every OASIS slug.
 */
export function oasisBoardProgramFilter(tenantSlug: string | null | undefined): {
  salesProgram: string | null;
  salesMotion: string | null;
} {
  return {
    salesProgram: tenantSlug === OASIS_WEBSITE_TENANT_SLUG ? OASIS_WEBSITE_SALES_PROGRAM : null,
    salesMotion: isWebsiteSalesTenantSlug(tenantSlug) ? OASIS_COLD_OUTBOUND_MOTION : null,
  };
}
