/**
 * DeliveryToday — the fulfilment screen. Internal workers (team_role='member')
 * and read-only viewers.
 *
 * A builder's morning question is "what is late and what ships today", not
 * "what is our MRR". So this page carries the four post-sale stages —
 * onboarding, in_build, client_review, launched — and nothing about money.
 *
 * SCOPED BY QUERY, LIKE THE REP PAGE. Four `where: { stage }` reads, one per
 * delivery stage. The prospecting pipeline is never fetched, so "no prospecting
 * pipeline for fulfilment" is a property of the request rather than a rule
 * someone has to remember when adding the next card. Company financials are not
 * imported here at all.
 *
 * Client names ARE shown. That is deliberate and it is the difference between
 * this persona and the sales one: a builder cannot build a website for a
 * customer they are not allowed to name.
 *
 * `readOnly` removes the affordances, not the information — the read_only role
 * is a viewer, and a viewer who is shown buttons that fail is worse off than
 * one who is shown none.
 */

import Link from "next/link";
import { Card, EmptyState, PageHeader, Stat, Tag } from "@/components/Card";
import { LiveClock } from "@/components/LiveClock";
import { listRecords, type TenantRecord } from "@/lib/manifest/data";
import { OASIS_LEAD_STAGES } from "@/lib/oasis-stage-meta";
import { operatorDateKey, operatorDayStartIso } from "@/lib/dates";
import { timeAgo, truncate } from "@/lib/fmt";

/** The post-sale lifecycle, in the order work moves through it. */
const DELIVERY_STAGE_KEYS = ["onboarding", "in_build", "client_review", "launched"] as const;
type DeliveryStageKey = (typeof DELIVERY_STAGE_KEYS)[number];

/** A build that has not moved in this long is stalled, whatever its stage says. */
const STALE_MS = 7 * 24 * 60 * 60 * 1000;

type LeadData = Record<string, unknown>;

function str(data: LeadData, key: string): string {
  const v = data[key];
  return typeof v === "string" ? v : "";
}

function labelFor(key: string): string {
  return OASIS_LEAD_STAGES.find((s) => s.key === key)?.label || key;
}

function colorFor(key: string): string {
  return OASIS_LEAD_STAGES.find((s) => s.key === key)?.bg || "#5E6B82";
}

function who(row: TenantRecord): string {
  const data = row.data as LeadData;
  return str(data, "company") || str(data, "name") || str(data, "email") || "unnamed client";
}

/**
 * One stage's rows, or a failure. Kept per-stage rather than one wide read so a
 * single stage failing degrades one tile instead of blanking the page — and so
 * the prospecting stages are never in the result set to begin with.
 */
type StageRead =
  | { ok: true; stage: DeliveryStageKey; rows: TenantRecord[] }
  | { ok: false; stage: DeliveryStageKey };

async function loadStage(tenantId: string, stage: DeliveryStageKey): Promise<StageRead> {
  try {
    const result = await listRecords({
      tenant_id: tenantId,
      entity: "lead",
      where: { stage },
      sort: "-updated_at",
      limit: 200,
    });
    return { ok: true, stage, rows: result.rows };
  } catch (err) {
    console.error(`[delivery-today.${stage}]`, err);
    return { ok: false, stage };
  }
}

export async function DeliveryToday({
  tenantId,
  viewerName,
  readOnly,
}: {
  tenantId: string;
  viewerName: string;
  readOnly: boolean;
}) {
  const reads = await Promise.all(DELIVERY_STAGE_KEYS.map((s) => loadStage(tenantId, s)));
  const byStage = new Map<DeliveryStageKey, StageRead>(reads.map((r) => [r.stage, r]));

  const countOf = (stage: DeliveryStageKey): number | "—" => {
    const r = byStage.get(stage);
    // Em dash, never 0, on a failed read: "there is no work in build" and
    // "I could not find out" are different facts and only one of them means
    // the builder can go home.
    return r && r.ok ? r.rows.length : "—";
  };

  const active = reads
    .filter((r): r is Extract<StageRead, { ok: true }> => r.ok)
    .filter((r) => r.stage !== "launched")
    .flatMap((r) => r.rows.map((row) => ({ row, stage: r.stage })));

  const now = Date.now();
  const dayStart = Date.parse(operatorDayStartIso());
  const dayEnd = Date.parse(operatorDayStartIso(new Date(), 1));

  const blocked: Array<{ row: TenantRecord; stage: DeliveryStageKey; why: string; at: number }> = [];
  const dueToday: Array<{ row: TenantRecord; stage: DeliveryStageKey; at: number }> = [];

  for (const { row, stage } of active) {
    const data = row.data as LeadData;
    const raw = str(data, "next_action_at");
    const at = raw ? Date.parse(raw) : NaN;
    if (Number.isFinite(at) && at < now) {
      blocked.push({ row, stage, why: "past its due date", at });
      continue;
    }
    if (Number.isFinite(at) && at >= dayStart && at < dayEnd) {
      dueToday.push({ row, stage, at });
      continue;
    }
    const touched = Date.parse(row.updated_at || "");
    if (Number.isFinite(touched) && now - touched > STALE_MS) {
      blocked.push({ row, stage, why: "no movement in a week", at: touched });
    }
  }
  blocked.sort((a, b) => a.at - b.at);
  dueToday.sort((a, b) => a.at - b.at);

  const anyReadFailed = reads.some((r) => !r.ok);
  const totalActive = active.length;

  return (
    <div className="space-y-6 animate-fade-in">
      <PageHeader
        title="Today"
        subtitle={
          <>
            <LiveClock initialDateKey={operatorDateKey()} /> · {viewerName} · delivery
          </>
        }
        action={
          readOnly ? (
            <Tag tone="neutral">view only</Tag>
          ) : (
            <Tag tone={blocked.length > 0 ? "warm" : "accent"}>
              {blocked.length > 0 ? `${blocked.length} need a nudge` : "clear"}
            </Tag>
          )
        }
      />

      {anyReadFailed && (
        <Card title="Partial read">
          <EmptyState message="At least one delivery queue could not be loaded. The tiles showing an em dash are unknown, not empty — reload before concluding there is no work." />
        </Card>
      )}

      <section className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {DELIVERY_STAGE_KEYS.map((stage) => (
          <Stat
            key={stage}
            label={labelFor(stage)}
            value={countOf(stage)}
            accent={stage === "in_build"}
            hint={
              byStage.get(stage)?.ok === false
                ? "could not read this queue"
                : stage === "launched"
                  ? "shipped"
                  : stage === "client_review"
                    ? "waiting on the client"
                    : stage === "in_build"
                      ? "yours to move"
                      : "kickoff pending"
            }
          />
        ))}
      </section>

      <section className="grid lg:grid-cols-2 gap-6">
        <Card
          title="Needs a nudge"
          subtitle={
            blocked.length > 0
              ? `${blocked.length} past due or stalled · oldest first`
              : "overdue and stalled builds"
          }
        >
          {blocked.length === 0 ? (
            <EmptyState message="Nothing is overdue and nothing has gone quiet for a week. Work the build queue." />
          ) : (
            <ul className="divide-y divide-bg-border">
              {blocked.slice(0, 8).map(({ row, stage, why, at }) => (
                <li key={row.id} className="py-3">
                  <Link
                    href={`/pipeline/${row.id}`}
                    className="block -mx-2 px-2 py-1 rounded-md hover:bg-bg-elev transition-colors"
                  >
                    <div className="flex items-center gap-2">
                      <Tag tone="warm">{why}</Tag>
                      <span className="text-[10px] uppercase tracking-wider font-bold text-fg-dim">
                        {labelFor(stage)}
                      </span>
                      <span className="ml-auto text-xs text-fg-dim">
                        {timeAgo(new Date(at).toISOString())}
                      </span>
                    </div>
                    <div className="mt-1.5 text-sm font-semibold text-fg">
                      {truncate(who(row), 60)}
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card
          title="Due today"
          subtitle={dueToday.length > 0 ? `${dueToday.length} scheduled` : "scheduled for today"}
        >
          {dueToday.length === 0 ? (
            <EmptyState message="Nothing is scheduled for today. Set dates on the builds you are working so they land here." />
          ) : (
            <ul className="divide-y divide-bg-border">
              {dueToday.slice(0, 8).map(({ row, stage }) => (
                <li key={row.id} className="py-3">
                  <Link
                    href={`/pipeline/${row.id}`}
                    className="block -mx-2 px-2 py-1 rounded-md hover:bg-bg-elev transition-colors"
                  >
                    <div className="flex items-center gap-2">
                      <span
                        className="h-2 w-2 rounded-full"
                        style={{ backgroundColor: colorFor(stage) }}
                        aria-hidden
                      />
                      <span className="text-[10px] uppercase tracking-wider font-bold text-fg-dim">
                        {labelFor(stage)}
                      </span>
                    </div>
                    <div className="mt-1.5 text-sm font-semibold text-fg">
                      {truncate(who(row), 60)}
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </section>

      <Card
        title="The build queue"
        subtitle={`${totalActive} active · launched work is not listed`}
        action={
          <Link href="/pipeline" className="text-xs text-fg-muted hover:text-accent transition-colors">
            Open pipeline →
          </Link>
        }
      >
        {totalActive === 0 ? (
          <EmptyState message="No websites are in delivery right now. New builds arrive here once a deal is won and moves to onboarding." />
        ) : (
          <div className="grid gap-4 md:grid-cols-3">
            {DELIVERY_STAGE_KEYS.filter((s) => s !== "launched").map((stage) => {
              const read = byStage.get(stage);
              const rows = read && read.ok ? read.rows : [];
              return (
                <div key={stage} className="rounded-lg border border-bg-border bg-bg-elev/40 p-4">
                  <div className="flex items-center gap-2">
                    <span
                      className="h-2 w-2 rounded-full"
                      style={{ backgroundColor: colorFor(stage) }}
                      aria-hidden
                    />
                    <span className="text-[10px] uppercase tracking-[0.14em] font-bold text-fg-muted">
                      {labelFor(stage)}
                    </span>
                    <span className="ml-auto text-xs font-bold tabular-nums text-fg">
                      {read && read.ok ? rows.length : "—"}
                    </span>
                  </div>
                  {read && !read.ok ? (
                    <p className="mt-3 text-xs text-fg-dim">Could not read this queue.</p>
                  ) : rows.length === 0 ? (
                    <p className="mt-3 text-xs text-fg-dim">Empty.</p>
                  ) : (
                    <ul className="mt-3 space-y-1.5">
                      {rows.slice(0, 6).map((row) => (
                        <li key={row.id}>
                          <Link
                            href={`/pipeline/${row.id}`}
                            className="block truncate text-xs text-fg-muted transition-colors hover:text-accent"
                          >
                            {truncate(who(row), 34)}
                          </Link>
                        </li>
                      ))}
                      {rows.length > 6 && (
                        <li className="text-[10px] text-fg-dim">+{rows.length - 6} more</li>
                      )}
                    </ul>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );
}
