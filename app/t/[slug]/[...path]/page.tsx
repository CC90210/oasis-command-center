import { notFound } from "next/navigation";
import { requireTenantPreviewAccess } from "@/lib/tenant-access";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { ManifestTable } from "@/components/manifest/ManifestTable";
import { ManifestKanban } from "@/components/manifest/ManifestKanban";
import { ManifestMarkdown } from "@/components/manifest/ManifestMarkdown";
import { ManifestDashboard } from "@/components/manifest/ManifestDashboard";
import { ManifestRecordForm } from "@/components/manifest/ManifestRecordForm";
import { ManifestReasoning } from "@/components/manifest/ManifestReasoning";
import { LeadsImportClient } from "@/components/leads/LeadsImportClient";
import { ShoppingOutClient } from "@/components/shopping-out/ShoppingOutClient";
import { OffersByDealClient } from "@/components/offers/OffersByDealClient";
import { LendersDirectoryClient } from "@/components/lenders/LendersDirectoryClient";
import { RenewalsV2 } from "@/components/renewals/RenewalsV2";
import { TenantSettings } from "@/components/settings/TenantSettings";
import { TenantAutomations } from "@/components/automations/TenantAutomations";
import { LeadTimelinePanel } from "@/components/leads/LeadTimelinePanel";
import { LeadDocumentsPanel } from "@/components/leads/LeadDocumentsPanel";
import { StageRail } from "@/components/manifest/StageRail";
import { PipelineSearchableTable } from "@/components/manifest/PipelineSearchableTable";
import { PageSearchBar } from "@/components/manifest/PageSearchBar";
import { LeadPipelineView } from "@/components/manifest/LeadPipelineView";
import { LeadDetailDrawer } from "@/components/leads/LeadDetailDrawer";
import {
  PIPELINE_COLUMNS,
  formatPipelineCell,
  pipelineRowHref,
} from "@/lib/pipeline-display";
import { filterRowsByQuery } from "@/lib/search-filter";
import { LEAD_PIPELINE_STAGES, OPPORTUNITY_PIPELINE_STAGES, findStage } from "@/lib/sunbiz-stage-meta";
import { humanize } from "@/lib/manifest/humanize";
import { getRecord, listRecords } from "@/lib/manifest/data";
import { Card, PageHeader, Tag } from "@/components/Card";
import { getManifest, manifestExists } from "@/lib/manifest/loader";
import { resolveDataTenant } from "@/lib/manifest/tenant-scope";
import { getSessionUser, getServiceSupabase } from "@/lib/supabase-server";
import type { ManifestPageDef } from "@/lib/manifest/schema";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Catch-all manifest renderer at `/t/<slug>/<...path>`.
 *
 * Phase 5 production replacement for the Phase 2 placeholder. Looks up
 * the matching `manifest.pages[]` entry by `path`, resolves the entity
 * (if any), and dispatches to the right primitive component based on
 * `page.kind`. Auth-gated by middleware; the per-action mutations live
 * inside each primitive's data layer and re-check tenant scope on
 * every write.
 *
 * Renders 404 for paths not in the manifest, so an operator who deletes
 * a page via the AI editor gets clean failure instead of a stale view.
 */
export default async function TenantCatchAllPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string; path: string[] }>;
  searchParams?: Promise<{
    view?: string;
    stage?: string;
    opp_stage?: string;
    q?: string;
    lead?: string;
    application?: string;
  }>;
}) {
  const { slug, path } = await params;
  const sp = (await searchParams) || {};
  const viewOverride: "table" | "kanban" | null =
    sp.view === "table" ? "table" : sp.view === "kanban" ? "kanban" : null;
  const stageFilter = typeof sp.stage === "string" && sp.stage ? sp.stage : null;
  const oppStageFilter = typeof sp.opp_stage === "string" && sp.opp_stage ? sp.opp_stage : null;
  const query = typeof sp.q === "string" && sp.q ? sp.q : null;
  // SunBiz lead-drawer triggers. Only honored on the SunBiz slug; the
  // catch-all silently ignores them on other tenants so an OASIS URL
  // with ?lead= in it doesn't pop a drawer that doesn't belong there.
  const UUID_RE_DRAWER = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const rawLead = typeof sp.lead === "string" ? sp.lead : null;
  const rawApp = typeof sp.application === "string" ? sp.application : null;
  const drawerLeadId = rawLead && UUID_RE_DRAWER.test(rawLead) ? rawLead : null;
  const drawerAppId = rawApp && UUID_RE_DRAWER.test(rawApp) ? rawApp : null;
  const normalised = slug.toLowerCase();
  if (!(await manifestExists(normalised))) notFound();

  // Tenant-preview gate (see lib/tenant-access.ts).
  await requireTenantPreviewAccess(normalised);

  const manifest = await getManifest(normalised);
  const subPath = path.join("/");

  // /new flag: when the trailing segment is "new", the operator wants to
  // create a record for the page's entity. Strip "/new" off the path
  // and resolve the underlying page, then render the form instead of
  // the list/kanban primitive.
  const isNewForm = subPath === "new" || subPath.endsWith("/new");
  const lookupPath = isNewForm
    ? (subPath === "new" ? "" : subPath.slice(0, -("/new".length)))
    : subPath;

  // Record-detail path: `/t/sun/leads/<uuid>`. Detected when the last
  // segment is a UUID and stripping it lands on a real page path.
  // Renders the ManifestRecordForm in edit mode with pre-populated
  // values — gives operators a clickable drill-down from Kanban cards
  // without building a separate detail-view primitive.
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const subPathSegs = subPath.split("/").filter(Boolean);
  const lastSeg = subPathSegs[subPathSegs.length - 1] || "";
  const isRecordDetail = !isNewForm && UUID_RE.test(lastSeg);
  const recordDetailId = isRecordDetail ? lastSeg : null;
  const recordDetailPath = isRecordDetail
    ? subPathSegs.slice(0, -1).join("/")
    : null;

  // Find the matching page by exact path match. If the caller passed
  // `/t/sun/leads/new` and the manifest only has a page at "leads",
  // we still match after stripping /new. Same logic handles
  // record-detail paths (`/t/sun/leads/<uuid>` matches the leads page).
  const lookupForPage = recordDetailPath ?? lookupPath;
  const pageDef =
    manifest.pages?.find((p) => p.path === lookupForPage) ||
    manifest.pages?.find((p) => lookupForPage !== "" && lookupForPage.startsWith(`${p.path}/`)) ||
    null;

  if (!pageDef) {
    return <UnknownPath slug={normalised} subPath={subPath} />;
  }

  const user = await getSessionUser();
  const service = getServiceSupabase();
  const profileRes = user
    ? await service
        .from("user_profiles")
        .select("tenant_id")
        .eq("auth_user_id", user.id)
        .maybeSingle()
    : { data: null };
  const userTenantId = (profileRes.data as { tenant_id: string | null } | null)?.tenant_id ?? null;
  // Resolve which tenant_id should scope record reads. If the caller
  // isn't the owner of this manifest, dataTenantId is null and the
  // primitives render in preview mode — shells visible, data empty.
  // Closes the cross-shell data-bleed bug.
  const dataTenantId = await resolveDataTenant(normalised, userTenantId);
  const isPreview = !!userTenantId && dataTenantId === null;

  // Record-detail view — opened when an operator clicks a Kanban card or
  // a row in a manifest table. Reuses ManifestRecordForm in edit mode so
  // every field on the record is visible + editable on one screen
  // without building a separate detail primitive.
  if (recordDetailId && pageDef.entity) {
    const entity = (manifest.data_model || []).find((e) => e.name === pageDef.entity);
    if (entity && dataTenantId) {
      const record = await getRecord({
        tenant_id: dataTenantId,
        entity: entity.name,
        id: recordDetailId,
      }).catch(() => null);
      if (!record) {
        return (
          <div className="space-y-4 animate-fade-in">
            <PageHeader
              title="Record not found"
              subtitle={`No ${entity.label.toLowerCase()} with id ${recordDetailId.slice(0, 8)}…`}
              action={
                <Link
                  href={`/t/${normalised}/${recordDetailPath}`}
                  className="btn-secondary inline-flex items-center gap-2 !px-3 !py-1.5 text-xs"
                >
                  <ArrowLeft className="h-3.5 w-3.5" />
                  Back to {pageDef.label.toLowerCase()}
                </Link>
              }
            />
          </div>
        );
      }
      // Resolve a sensible display title from the record's data —
      // tries `name` / `title` / `business_name` in that order, then
      // falls back to the short id.
      const title =
        (typeof record.data.name === "string" && record.data.name) ||
        (typeof record.data.title === "string" && record.data.title) ||
        (typeof record.data.business_name === "string" && record.data.business_name) ||
        `${entity.label} ${recordDetailId.slice(0, 8)}`;
      const documentLeadId =
        entity.name === "application" &&
        typeof (record.data as Record<string, unknown>).lead_id === "string" &&
        UUID_RE.test((record.data as Record<string, unknown>).lead_id as string)
          ? ((record.data as Record<string, unknown>).lead_id as string)
          : recordDetailId;
      return (
        <div className="space-y-4 animate-fade-in">
          <PageHeader
            title={title}
            subtitle={`${entity.label} · ${entity.fields.length} fields`}
            action={
              <Link
                href={`/t/${normalised}/${recordDetailPath}`}
                className="btn-secondary inline-flex items-center gap-2 !px-3 !py-1.5 text-xs"
              >
                <ArrowLeft className="h-3.5 w-3.5" />
                Back to {pageDef.label.toLowerCase()}
              </Link>
            }
          />
          {(() => {
            // Missing-info banner — surfaces Phase 20 classifier output
            // at the top of the lead detail so the operator sees what's
            // owed before reading any other field. Only on the `lead`
            // entity; other entities don't carry missing_info.
            if (entity.name !== "lead") return null;
            const mi = (record.data as Record<string, unknown>)?.missing_info;
            const items = Array.isArray(mi)
              ? (mi as unknown[]).filter((x): x is string => typeof x === "string")
              : [];
            if (items.length === 0) return null;
            return (
              <div className="rounded-2xl border border-red-500/40 bg-red-500/10 p-4 text-sm leading-relaxed text-red-200">
                <div className="font-semibold text-red-100 mb-1">
                  🔴 Lender asked for additional documentation
                </div>
                <div className="font-mono text-[12.5px]">
                  Missing: {items.join(", ")}
                </div>
                <div className="text-[11.5px] text-red-200/80 mt-1.5">
                  Auto-detected from the lender&apos;s reply. Clear an item by editing this lead&apos;s
                  <span className="font-mono"> missing_info</span> field once the doc is sent.
                </div>
              </div>
            );
          })()}
          <ManifestRecordForm
            tenantSlug={normalised}
            entity={entity}
            backPath={recordDetailPath!}
            initial={record.data}
            editId={recordDetailId}
          />
          {entity.name === "lead" && (
            <LeadTimelinePanel leadId={recordDetailId} />
          )}
          {(entity.name === "lead" || entity.name === "application") &&
            dataTenantId && (
              <LeadDocumentsPanel
                tenantId={dataTenantId}
                leadId={documentLeadId}
              />
            )}
        </div>
      );
    }
  }

  // Create-form view — the actual functional "New <entity>" button target.
  if (isNewForm && pageDef.entity) {
    const entity = (manifest.data_model || []).find((e) => e.name === pageDef.entity);
    if (!entity) {
      return (
        <div className="space-y-4 animate-fade-in">
          <PageHeader title={`New ${pageDef.label}`} subtitle="Entity not in manifest" />
          <Card>
            <div className="text-sm text-fg-muted">
              This page references entity <span className="font-mono text-fg">{pageDef.entity}</span> but
              the manifest&apos;s data_model doesn&apos;t define it. Open the AI editor to add the entity.
            </div>
          </Card>
        </div>
      );
    }
    if (isPreview) {
      // Creating records in someone else's shell would write to YOUR
      // tenant's records under their entity_type — wrong on every axis.
      return (
        <div className="space-y-4 animate-fade-in">
          <PageHeader
            title={`New ${entity.label.toLowerCase()}`}
            subtitle="Preview mode — record creation disabled"
            action={
              <Link
                href={`/t/${normalised}/${lookupPath}`}
                className="btn-secondary inline-flex items-center gap-2 !px-3 !py-1.5 text-xs"
              >
                <ArrowLeft className="h-3.5 w-3.5" />
                Back
              </Link>
            }
          />
          <div className="rounded-2xl border border-amber-300/25 bg-amber-300/10 p-4 text-sm leading-relaxed text-amber-100">
            You&apos;re previewing the <strong className="text-fg">{manifest.brand.name}</strong> shell.
            Records can only be created by the tenant that owns this slug.
          </div>
        </div>
      );
    }
    return (
      <div className="space-y-4 animate-fade-in">
        <PageHeader
          title={`New ${entity.label.toLowerCase()}`}
          subtitle={`${manifest.brand.name} · ${entity.fields.length} fields`}
          action={
            <Link
              href={`/t/${normalised}/${lookupPath}`}
              className="btn-secondary inline-flex items-center gap-2 !px-3 !py-1.5 text-xs"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              Back
            </Link>
          }
        />
        <ManifestRecordForm
          tenantSlug={normalised}
          entity={entity}
          backPath={lookupPath}
        />
      </div>
    );
  }

  return (
    <div className="space-y-6 animate-fade-in">
      <PageHeader
        title={pageDef.label}
        subtitle={renderSubtitle(manifest.brand.name, pageDef)}
        // Only the preview-mode tag is operator-relevant here. The
        // page.kind tag ("kanban" / "table" / "form") used to live in
        // this slot but was a leak of internal manifest vocabulary
        // into the operator UI — operators asked "what does kanban
        // mean? is that a signal reference?" The view toggle below
        // the header already exposes the kanban-vs-table choice
        // visually, so the tag was redundant on top of being confusing.
        action={isPreview ? <Tag tone="warm">preview</Tag> : null}
      />
      {isPreview && (
        <div className="rounded-2xl border border-amber-300/25 bg-amber-300/10 p-4 text-sm leading-relaxed text-amber-100">
          You&apos;re viewing the <strong className="text-fg">{manifest.brand.name}</strong> shell
          in preview mode. Your tenant doesn&apos;t own this slug, so no live records render —
          but the manifest structure, navigation, and entity schemas are exactly what a real{" "}
          <span className="font-mono">/t/{normalised}</span> tenant would see.
        </div>
      )}
      <PageBody
        slug={normalised}
        tenantId={dataTenantId}
        page={pageDef}
        manifest={manifest}
        viewOverride={viewOverride}
        stageFilter={stageFilter}
        oppStageFilter={oppStageFilter}
        query={query}
      />
      {normalised === "sun" && drawerLeadId && (
        <LeadDetailDrawer tenantSlug={normalised} recordId={drawerLeadId} entity="lead" />
      )}
      {normalised === "sun" && !drawerLeadId && drawerAppId && (
        <LeadDetailDrawer tenantSlug={normalised} recordId={drawerAppId} entity="application" />
      )}
    </div>
  );
}

function renderSubtitle(brand: string, page: ManifestPageDef): string {
  switch (page.kind) {
    case "dashboard": return `${brand} · live snapshot`;
    case "table": return page.entity ? `${humanizeEntity(page.entity)}` : "Table view";
    case "kanban": return page.entity ? `${humanizeEntity(page.entity)} by stage` : "Kanban view";
    case "form": return page.entity ? `Form for ${humanizeEntity(page.entity)}` : "Form";
    case "markdown": return "Reference page";
    case "reasoning": return "Click an action to send it straight to chat.";
    case "import": return "Paste a CSV or drop a file. Duplicate-check is automatic.";
    case "pipeline": return "Lead Pipeline and Opportunity Pipeline — Salesforce-parity overview.";
    case "pipeline_entity": return page.entity ? `${humanizeEntity(page.entity)} by stage` : "Pipeline";
    case "shopping_out": return "Multi-lender outreach — pick lenders, attach docs, send.";
    case "offers_v2": return "Offers by deal — lender intelligence, accordion + kanban views.";
    case "lenders_v2": return "Lender directory — buy rates, restricted states, decline reasons.";
    case "renewals_v2": return "Funded deals ranked by renewal urgency.";
    case "settings": return "Tenant-scoped — owner sees full settings, preview shows scaffold only.";
    case "automations": return "Tenant-scoped automations — cron jobs, bridge status, AI-described drafts.";
    default: return brand;
  }
}

function humanizeEntity(name: string): string {
  return humanize(name) + "s";
}


async function PageBody({
  slug,
  tenantId,
  page,
  manifest,
  viewOverride,
  stageFilter,
  oppStageFilter,
  query,
}: {
  slug: string;
  tenantId: string | null;
  page: ManifestPageDef;
  manifest: Awaited<ReturnType<typeof getManifest>>;
  viewOverride: "table" | "kanban" | null;
  stageFilter: string | null;
  oppStageFilter: string | null;
  query: string | null;
}) {
  switch (page.kind) {
    case "markdown":
      return <ManifestMarkdown page={page} />;
    case "reasoning":
      return <ManifestReasoning manifest={manifest} tenantSlug={slug} />;
    case "dashboard":
      return <ManifestDashboard manifest={manifest} tenantId={tenantId} />;
    case "import":
      // The import page reads the operator's tenant_id server-side via
      // /api/leads/import; no extra props needed. Tenant_id check
      // happens inside the API route so a viewer in preview-mode can't
      // accidentally bulk-insert into someone else's leads table.
      return <LeadsImportClient />;
    case "shopping_out":
      // Phase 4 (Jordan/Oasis 2026-05-23). Multi-lender outreach UI;
      // ranks lenders via lib/lenders/match-fitness, attaches docs,
      // POSTs to /api/applications/[id]/shop-out, surfaces resulting
      // application_lender_threads. Tenant-scoped reads in the client.
      return (
        <ShoppingOutClient
          tenantSlug={slug}
          tenantId={tenantId}
        />
      );
    case "offers_v2":
      // Phase 6 (Jordan/Oasis 2026-05-23). Deal-first accordion + kanban
      // toggle over application_lender_threads grouped by application.
      return (
        <OffersByDealClient
          tenantSlug={slug}
          tenantId={tenantId}
        />
      );
    case "lenders_v2":
      // Phase 7 (Jordan/Oasis 2026-05-23). Lender knowledge base — table
      // + LenderDetailDrawer with the expanded field set.
      return (
        <LendersDirectoryClient
          tenantSlug={slug}
          tenantId={tenantId}
        />
      );
    case "renewals_v2":
      // Phase 8 (Jordan/Oasis 2026-05-23). Funded-deals-backed renewals
      // view with progress bars + urgency sort + wired tel:/mailto:.
      // Replaces the generic kind="kanban" rendering of the unused
      // `renewal` entity. RenewalsV2 is async (server component) — it
      // reads getRenewalsSummary + getRenewalsRows server-side.
      return <RenewalsV2 tenantId={tenantId} />;
    case "settings":
      // Tenant-scoped Settings (2026-05-25). Routed here instead of
      // top-level /settings to fix the cross-tenant leak — operator
      // previewing a non-owned tenant gets the preview-mode scaffold
      // (no sub-components mount, no fetches), while the tenant owner
      // sees the full SettingsContent with their data scoped to this
      // tenant. The dataTenantId gate (null for non-owners) controls
      // which branch renders inside TenantSettings.
      return <TenantSettings tenantSlug={slug} tenantId={tenantId} />;
    case "automations":
      // Tenant-scoped Automations — same Option A pattern as Settings.
      return <TenantAutomations tenantSlug={slug} tenantId={tenantId} />;
    case "pipeline": {
      // Stacked superview — Lead Pipeline above Opportunity Pipeline.
      // Each section has its own chevron bar + filtered table. Filter
      // params are independent so both bars work in parallel.
      return (
        <PipelineSuperview
          slug={slug}
          tenantId={tenantId}
          page={page}
          manifest={manifest}
          stageFilter={stageFilter}
          oppStageFilter={oppStageFilter}
        />
      );
    }
    case "pipeline_entity": {
      // Single-entity chevron pipeline — used by /leads (entity=lead) and
      // /applications (entity=application). Reads `stage_field` from
      // page.config (defaults to "stage"; applications use "status").
      // Filter via ?stage=<key>.
      const cfg = (page.config || {}) as { stage_field?: string };
      const stageField = cfg.stage_field || "stage";
      const entityName = page.entity || "";
      const entity = (manifest.data_model || []).find((e) => e.name === entityName);
      if (!entity) {
        return (
          <div className="rounded-2xl border border-amber-300/25 bg-amber-300/10 p-5 text-sm text-amber-100 leading-relaxed">
            Pipeline entity <code>{entityName}</code> isn&apos;t defined in this manifest.
          </div>
        );
      }
      return (
        <SingleEntityPipeline
          slug={slug}
          tenantId={tenantId}
          page={page}
          entity={entity}
          stageField={stageField}
          stageFilter={stageFilter}
          query={query}
        />
      );
    }
    case "table":
    case "kanban":
    case "form": {
      const entity = (manifest.data_model || []).find((e) => e.name === page.entity);
      if (!entity) {
        return (
          <div className="rounded-2xl border border-amber-300/25 bg-amber-300/10 p-5 text-sm text-amber-100 leading-relaxed">
            This page references an entity <span className="font-mono text-fg">{page.entity || "(none)"}</span> that
            isn&apos;t defined in the manifest&apos;s <code>data_model</code>. Open the AI editor
            and add it, or remove the page reference.
          </div>
        );
      }
      // `view` query param overrides the manifest's default kind for
      // table-vs-kanban entities. Lets the operator flip between a
      // dense sortable table and the stage-Kanban without an admin
      // changing the manifest. Form pages don't have a "kanban"
      // alternative, so the override only applies to kanban/table.
      const effectiveKind: "kanban" | "table" =
        page.kind === "form"
          ? "table"
          : viewOverride
            ? viewOverride
            : (page.kind as "kanban" | "table");

      // Toggle bar — rendered above the body so the operator can flip
      // views without leaving the page. Only meaningful when the entity
      // has a group-by-able field (otherwise the Kanban renders as one
      // big column and the toggle is pointless).
      const supportsKanban =
        page.kind === "kanban" ||
        entity.fields.some((f) => f.type === "enum") ||
        entity.fields.some((f) => f.name === "stage" || f.name === "status");

      const toggle = supportsKanban ? (
        <ViewToggle slug={slug} path={page.path} current={effectiveKind} />
      ) : null;

      // Universal search bar above every Kanban + Table list page so
      // /offers, /funded-deals, /renewals, /commissions, /lenders all
      // gain Salesforce-style "Search this list" without a per-page
      // refactor. Query lands in the URL ?q= and the Kanban / Table
      // server components filter their rows post-fetch.
      const newHref = page.kind === "form" ? undefined : `/t/${slug}/${page.path}/new`;
      const searchBar = (
        <PageSearchBar entityLabel={entity.label} newHref={newHref} />
      );

      if (effectiveKind === "kanban") {
        return (
          <>
            {toggle}
            {searchBar}
            <ManifestKanban
              tenantSlug={slug}
              tenantId={tenantId}
              entity={entity}
              page={page}
              query={query ?? undefined}
            />
          </>
        );
      }
      return (
        <>
          {toggle}
          {searchBar}
          <ManifestTable
            tenantSlug={slug}
            tenantId={tenantId}
            entity={entity}
            page={page}
            canCreate
            query={query ?? undefined}
          />
        </>
      );
    }
    default:
      return (
        <div className="rounded-2xl border border-bg-border bg-bg-elev/40 p-5 text-sm text-fg-muted">
          Unknown page kind: <span className="font-mono">{(page as ManifestPageDef).kind}</span>
        </div>
      );
  }
}

/**
 * ViewToggle — small two-button toolbar above the body that lets the
 * operator switch a manifest page between Kanban and Table views.
 *
 * Why server-side links instead of a client toggle: this whole route is
 * a server component, and the underlying ManifestKanban / ManifestTable
 * both fetch their own data. A `?view=` URL param keeps the bookmark /
 * back-button behavior natural (e.g. an operator can email a teammate
 * a link to "/t/sun/leads?view=table" and they land on the same view).
 */
function ViewToggle({
  slug,
  path,
  current,
}: {
  slug: string;
  path: string;
  current: "kanban" | "table";
}) {
  return (
    <div className="flex items-center gap-1 mb-3">
      <Link
        href={`/t/${slug}/${path}?view=kanban`}
        className={`text-[10px] uppercase tracking-wider px-2.5 py-1 rounded-md border ${
          current === "kanban"
            ? "border-accent/50 bg-accent/10 text-accent"
            : "border-bg-border bg-bg-elev/40 text-fg-muted hover:text-fg"
        }`}
      >
        Kanban
      </Link>
      <Link
        href={`/t/${slug}/${path}?view=table`}
        className={`text-[10px] uppercase tracking-wider px-2.5 py-1 rounded-md border ${
          current === "table"
            ? "border-accent/50 bg-accent/10 text-accent"
            : "border-bg-border bg-bg-elev/40 text-fg-muted hover:text-fg"
        }`}
      >
        Table
      </Link>
    </div>
  );
}

/**
 * PipelineSuperview — Salesforce-replacement two-pipeline page renderer.
 *
 * Renders the Lead Pipeline chevron bar + filtered record table, then
 * the Opportunity Pipeline chevron bar + filtered record table. Each
 * chevron is clickable; clicking applies a URL filter (stage= or
 * opp_stage=) so the operator can drill into one stage without losing
 * sight of the other pipeline.
 *
 * Per-stage record counts are pre-computed server-side from listRecords
 * so the chevrons render with badges showing "how many in this stage."
 */
async function PipelineSuperview({
  slug,
  tenantId,
  page,
  manifest,
  stageFilter,
  oppStageFilter,
}: {
  slug: string;
  tenantId: string | null;
  page: ManifestPageDef;
  manifest: Awaited<ReturnType<typeof getManifest>>;
  stageFilter: string | null;
  oppStageFilter: string | null;
}) {
  const cfg = (page.config || {}) as { lead_entity?: string; opportunity_entity?: string };
  const leadName = cfg.lead_entity || "lead";
  const oppName = cfg.opportunity_entity || "application";
  const leadEntity = (manifest.data_model || []).find((e) => e.name === leadName);
  const oppEntity = (manifest.data_model || []).find((e) => e.name === oppName);
  if (!leadEntity || !oppEntity) {
    return (
      <div className="rounded-2xl border border-amber-300/25 bg-amber-300/10 p-5 text-sm text-amber-100 leading-relaxed">
        Pipeline superview references entities <code>{leadName}</code> and <code>{oppName}</code> — at least one
        isn&apos;t defined in the manifest&apos;s <code>data_model</code>.
      </div>
    );
  }

  // Resolve the stage field per entity. lead uses `stage`; application
  // uses `status` (Salesforce naming kept on the application entity);
  // offer also uses `stage`. Lookup keys on the row's data jsonb.
  const leadStageField = "stage";
  const oppStageField = oppName === "application" ? "status" : "stage";

  // Fetch every record for each pipeline once; partition client-side
  // into stage buckets. Cheaper than N round-trips (one per stage) and
  // gives us accurate counts for the chevron badges in the same query.
  const [leadRowsRes, oppRowsRes] = await Promise.all([
    tenantId
      ? listRecords({ tenant_id: tenantId, entity: leadName, limit: 2_000 }).catch(() => ({ rows: [], total: 0 }))
      : Promise.resolve({ rows: [], total: 0 }),
    tenantId
      ? listRecords({ tenant_id: tenantId, entity: oppName, limit: 2_000 }).catch(() => ({ rows: [], total: 0 }))
      : Promise.resolve({ rows: [], total: 0 }),
  ]);

  const leadCounts: Record<string, number> = {};
  for (const r of leadRowsRes.rows) {
    const s = String((r.data as Record<string, unknown>)[leadStageField] || "");
    if (s) leadCounts[s] = (leadCounts[s] || 0) + 1;
  }
  const oppCounts: Record<string, number> = {};
  for (const r of oppRowsRes.rows) {
    const s = String((r.data as Record<string, unknown>)[oppStageField] || "");
    if (s) oppCounts[s] = (oppCounts[s] || 0) + 1;
  }

  const leadVisible = stageFilter
    ? leadRowsRes.rows.filter((r) => String((r.data as Record<string, unknown>)[leadStageField] || "") === stageFilter)
    : leadRowsRes.rows;
  const oppVisible = oppStageFilter
    ? oppRowsRes.rows.filter((r) => String((r.data as Record<string, unknown>)[oppStageField] || "") === oppStageFilter)
    : oppRowsRes.rows;

  return (
    <div className="space-y-10">
      <section className="space-y-4">
        <div className="flex items-baseline justify-between gap-4">
          <h2 className="text-lg font-bold text-fg">Lead Pipeline</h2>
          <div className="text-[11px] text-fg-dim font-mono">
            {stageFilter ? `${leadVisible.length} in ${findStage("lead", stageFilter)?.label || stageFilter}` : `${leadRowsRes.rows.length} total`}
          </div>
        </div>
        <PipelineLayout vertical={slug === "sun"}>
          <StageRail
            tenantSlug={slug}
            stages={LEAD_PIPELINE_STAGES}
            activeKey={stageFilter}
            basePath={`/t/${slug}/${page.path}`}
            counts={leadCounts}
          />
          <PipelineRecordList
            slug={slug}
            entityName={leadName}
            stageField={leadStageField}
            rows={leadVisible}
            activeStageLabel={stageFilter ? findStage("lead", stageFilter)?.label || stageFilter : "All stages"}
          />
        </PipelineLayout>
      </section>

      <section className="space-y-4">
        <div className="flex items-baseline justify-between gap-4">
          <h2 className="text-lg font-bold text-fg">Opportunity Pipeline</h2>
          <div className="text-[11px] text-fg-dim font-mono">
            {oppStageFilter ? `${oppVisible.length} in ${findStage(oppName, oppStageFilter)?.label || oppStageFilter}` : `${oppRowsRes.rows.length} total`}
          </div>
        </div>
        <PipelineLayout vertical={slug === "sun"}>
          <StageRail
            tenantSlug={slug}
            stages={OPPORTUNITY_PIPELINE_STAGES}
            activeKey={oppStageFilter}
            basePath={`/t/${slug}/${page.path}`}
            counts={oppCounts}
            paramName="opp_stage"
          />
          <PipelineRecordList
            slug={slug}
            entityName={oppName}
            stageField={oppStageField}
            rows={oppVisible}
            activeStageLabel={oppStageFilter ? findStage(oppName, oppStageFilter)?.label || oppStageFilter : "All opportunities"}
          />
        </PipelineLayout>
      </section>
    </div>
  );
}

/**
 * PipelineRecordList — compact table rendered below each pipeline bar.
 *
 * Salesforce shows a tabular layout under each pipeline stage filter.
 * We do the same — name + key contact fields + stage tag. Empty state
 * renders explicitly so a fresh tenant doesn't see a blank container.
 */
function PipelineRecordList({
  slug,
  entityName,
  stageField,
  rows,
  activeStageLabel,
}: {
  slug: string;
  entityName: string;
  stageField: string;
  rows: { id: string; data: Record<string, unknown> }[];
  activeStageLabel: string;
}) {
  if (rows.length === 0) {
    return (
      <div className="rounded-2xl border border-bg-border bg-bg-deep/40 p-6 text-center text-sm text-fg-dim italic">
        No records in {activeStageLabel}.
      </div>
    );
  }

  // Display columns + link base resolved from the shared
  // lib/pipeline-display module — single source of truth, shared with
  // PipelineSearchableTable. Adding a column once propagates to both
  // the searchable variant and the unsearchable superview-side list.
  const cols = PIPELINE_COLUMNS[entityName] || [];
  const rowHref = (id: string) => pipelineRowHref(slug, entityName, id);

  return (
    <div className="overflow-x-auto rounded-2xl border border-bg-border bg-bg-deep/30">
      <table className="w-full text-[12.5px]">
        <thead>
          <tr className="text-left text-fg-dim border-b border-bg-border">
            {cols.map((c) => (
              <th key={c.key} className="px-3 py-2 font-medium">{c.label}</th>
            ))}
            <th className="px-3 py-2 font-medium">Stage</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const stage = String(r.data[stageField] || "");
            const stageMeta = findStage(entityName, stage);
            return (
              <tr key={r.id} className="border-b border-bg-border/40 last:border-b-0 hover:bg-bg-elev/30">
                {cols.map((c, idx) => (
                  <td key={c.key} className={`px-3 py-2 ${idx === 0 ? "font-medium text-fg" : "text-fg-muted"}`}>
                    {idx === 0 ? (
                      <Link href={rowHref(r.id)} className="hover:underline">
                        {formatPipelineCell(r.data[c.key], c.key)}
                      </Link>
                    ) : (
                      formatPipelineCell(r.data[c.key], c.key)
                    )}
                  </td>
                ))}
                <td className="px-3 py-2">
                  {stageMeta ? (
                    <span
                      className="inline-block px-2 py-0.5 rounded text-[11px] font-semibold"
                      style={{ background: stageMeta.bg, color: stageMeta.fg }}
                    >
                      {stageMeta.label}
                    </span>
                  ) : (
                    <span className="text-fg-dim font-mono">{stage || "—"}</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * SingleEntityPipeline — the chevron bar + filtered table for ONE entity.
 *
 * Used by /leads (lead entity, Lead Pipeline) and /applications
 * (application entity, Opportunity Pipeline). Mirrors what each section
 * of the PipelineSuperview renders, just standalone with one entity's
 * chevron chain.
 */
async function SingleEntityPipeline({
  slug,
  tenantId,
  page,
  entity,
  stageField,
  stageFilter,
  query,
}: {
  slug: string;
  tenantId: string | null;
  page: ManifestPageDef;
  entity: { name: string; label: string; fields: { name: string; type: string }[] };
  stageField: string;
  stageFilter: string | null;
  query: string | null;
}) {
  const stages = entity.name === "lead"
    ? LEAD_PIPELINE_STAGES
    : entity.name === "application" || entity.name === "offer"
      ? OPPORTUNITY_PIPELINE_STAGES
      : [];

  if (stages.length === 0) {
    return (
      <div className="rounded-2xl border border-amber-300/25 bg-amber-300/10 p-5 text-sm text-amber-100 leading-relaxed">
        No Salesforce-parity pipeline stages registered for entity <code>{entity.name}</code>.
      </div>
    );
  }

  const rowsRes = tenantId
    ? await listRecords({ tenant_id: tenantId, entity: entity.name, limit: 2_000 }).catch(() => ({ rows: [], total: 0 }))
    : { rows: [], total: 0 };

  // Apply ?q= search filter FIRST so the chevron stage counts reflect
  // the search-narrowed set (matches Salesforce: typing in the search
  // box updates the stage badges to "how many in this stage that also
  // match my query"). Same matcher as every other list surface;
  // implementation in lib/search-filter.ts.
  const searched = filterRowsByQuery(rowsRes.rows, query);

  const counts: Record<string, number> = {};
  for (const r of searched) {
    const s = String((r.data as Record<string, unknown>)[stageField] || "");
    if (s) counts[s] = (counts[s] || 0) + 1;
  }

  const visible = stageFilter
    ? searched.filter((r) => String((r.data as Record<string, unknown>)[stageField] || "") === stageFilter)
    : searched;

  const activeLabel = stageFilter
    ? findStage(entity.name, stageFilter)?.label || stageFilter
    : `All ${entity.label.toLowerCase()}s`;

  const localCols = PIPELINE_COLUMNS[entity.name] || [];
  // Plain stage_key -> StageMeta map — functions can't cross the
  // server/client boundary, so this is what PipelineSearchableTable
  // gets instead of findStage.
  const stageMap: Record<string, typeof stages[number]> = Object.fromEntries(
    stages.map((s) => [s.key, s]),
  );

  // CRM entities get the grouped-by-stage command view across tenants.
  // SunBiz is the first full implementation, but the mechanics are the
  // standard leads/applications surface for Oasis and future tenants too.
  if (entity.name === "lead" || entity.name === "application") {
    return (
      <LeadPipelineView
        slug={slug}
        entityName={entity.name as "lead" | "application"}
        entityLabel={entity.label}
        stages={stages}
        stageField={stageField}
        rows={searched}
        stageFilter={stageFilter}
        query={query}
        basePath={page.path}
      />
    );
  }

  return (
    <div className="space-y-4">
      <PageSearchBar
        entityLabel={entity.label}
        newHref={`/t/${slug}/${page.path}/new`}
      />
      <div className="text-[11px] text-fg-dim font-mono">
        {query && query.trim()
          ? `${visible.length} match${visible.length === 1 ? "" : "es"} for "${query}"${stageFilter ? ` in ${activeLabel}` : ""}`
          : stageFilter ? `${visible.length} in ${activeLabel}` : `${rowsRes.rows.length} total`}
      </div>
      <StageRail
        tenantSlug={slug}
        stages={stages}
        activeKey={stageFilter}
        basePath={`/t/${slug}/${page.path}`}
        counts={counts}
      />
      <PipelineSearchableTable
        entityLabel={entity.label}
        stageField={stageField}
        rows={visible}
        columns={localCols}
        stageMap={stageMap}
        tenantSlug={slug}
        entityName={entity.name}
        activeStageLabel={activeLabel}
        query={query}
      />
    </div>
  );
}

/**
 * PipelineLayout — wraps a StageRail + record list. Renders as a
 * 2-column grid (rail-left, list-right) when `vertical` is true (SunBiz
 * uses this shape), or as a stacked column otherwise (every other
 * tenant keeps the horizontal chevron-above-table layout).
 *
 * Exists to kill the previous "branch on slug, duplicate the children"
 * pattern that sat at three call sites.
 */
function PipelineLayout({
  vertical,
  children,
}: {
  vertical: boolean;
  children: React.ReactNode;
}) {
  if (vertical) {
    return (
      <div className="grid grid-cols-1 lg:grid-cols-[260px_1fr] gap-4">
        {children}
      </div>
    );
  }
  return <>{children}</>;
}

function UnknownPath({ slug, subPath }: { slug: string; subPath: string }) {
  return (
    <div className="space-y-4 animate-fade-in">
      <PageHeader title="Not in this manifest" subtitle={`/t/${slug}/${subPath}`} />
      <div className="rounded-2xl border border-bg-border bg-bg-elev/40 p-5 text-sm text-fg-muted leading-relaxed">
        The manifest for <code className="text-accent">{slug}</code> doesn&apos;t have a page
        at <code className="text-accent">/{subPath}</code>. Open the AI editor to add one,
        or browse the existing routes from the sidebar.
      </div>
    </div>
  );
}
