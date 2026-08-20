/**
 * RepToday — the first screen an outside sales contractor sees each morning.
 *
 * WHO THIS IS FOR. Commission-only appointment setters on the `oasis-webdev`
 * workspace (team_role='agent'). They are not employees and they are not
 * insiders: they must never see OASIS's revenue, its MRR, its client names, its
 * client concentration, or another rep's book. Everything on this page is
 * either theirs or a published rule of the comp plan.
 *
 * THE ENFORCEMENT IS THE FETCH, NOT THE RENDER. There is no `if (isAdmin)`
 * hiding a number further down. The company-financial queries — mrrSnapshot,
 * mrrHistory, topClientConcentration, pipelineBreakdown, priorityInbound — are
 * not imported by this file at all, so they cannot run on this path. A number
 * that is fetched and then hidden still ships inside the RSC payload and is
 * readable in devtools; the only way a rep cannot read the MRR is for the MRR
 * never to be asked for.
 *
 * WHAT IT IS TRYING TO DO. Make someone want to dial. The order is deliberate:
 * who to call first, then how much work is waiting, then what it is worth. Not
 * charts. A setter's morning question is "who do I call", and the answer is the
 * top card.
 *
 * NO INVENTED NUMBERS. Every figure is a real row or an em dash. If the
 * commission table cannot be read, the tiles say so rather than reading $0 —
 * a rep seeing a confident zero next to their name would reasonably conclude
 * they had not been paid for work they did.
 */

import Link from "next/link";
import { Card, EmptyState, PageHeader, Stat, Tag } from "@/components/Card";
import { LiveClock } from "@/components/LiveClock";
import { LayoutList, PhoneCall } from "lucide-react";
import { getServiceSupabase } from "@/lib/supabase-server";
import { listRecords, type TenantRecord } from "@/lib/manifest/data";
import {
  filterWebsiteSalesRows,
  stagesForOasisRole,
} from "@/lib/oasis-sales-pipeline-policy";
import { COMMISSION_MODEL } from "@/lib/website-sales";
import { operatorDateKey, operatorDayStartIso } from "@/lib/dates";
import { timeAgo, truncate } from "@/lib/fmt";

type LeadData = Record<string, unknown>;

/** A read that can fail. `ok:false` means "could not find out", which is not zero. */
type Read<T> = { ok: true; value: T } | { ok: false };

type CommissionRow = {
  id: string;
  amount: number | null;
  rate: number | null;
  status: string | null;
  collected_setup_amount: number | null;
  created_at: string | null;
};

function str(data: LeadData, key: string): string {
  const v = data[key];
  return typeof v === "string" ? v : "";
}

function money(n: number): string {
  return `$${Math.round(n).toLocaleString()}`;
}

/**
 * The rep's own book, scoped in the QUERY (`where: assigned_to = me`) and then
 * narrowed again by the shared policy helper.
 *
 * Both layers are load-bearing and they are not redundant. The where-clause is
 * what stops the other reps' rows ever reaching this process;
 * filterWebsiteSalesRows is what keeps this page agreeing with /pipeline about
 * which PROGRAM and which STAGES a rep works — that rule lives in one file and
 * this surface must not fork it.
 */
async function loadMyQueue(
  tenantId: string,
  userId: string,
  teamRole: string,
): Promise<Read<TenantRecord[]>> {
  try {
    const result = await listRecords({
      tenant_id: tenantId,
      entity: "lead",
      where: { assigned_to: userId.toLowerCase() },
      limit: 300,
    });
    return {
      ok: true,
      value: filterWebsiteSalesRows(result.rows, {
        role: teamRole,
        userId,
        // Hard false, not "whatever the session said". This component only ever
        // renders for the sales persona; passing the flags through would mean a
        // future caller could widen the query by handing in a different session.
        isOwner: false,
        adminAccess: false,
      }),
    };
  } catch (err) {
    console.error("[rep-today.queue]", err);
    return { ok: false };
  }
}

/**
 * This rep's commission rows. `rep_user_id = me` is the whole security model
 * here — the same predicate GET /api/website-sales/commissions applies for a
 * non-admin caller, so the page and the API cannot disagree about what a rep
 * has earned.
 */
async function loadMyCommissions(
  tenantId: string,
  userId: string,
): Promise<Read<CommissionRow[]>> {
  try {
    const db = getServiceSupabase();
    const result = await db
      .from("website_sales_commissions")
      .select("id,amount,rate,status,collected_setup_amount,created_at")
      .eq("tenant_id", tenantId)
      .eq("rep_user_id", userId)
      .order("created_at", { ascending: false })
      .limit(200);
    if (result.error) {
      console.error("[rep-today.commissions]", result.error);
      return { ok: false };
    }
    return { ok: true, value: (result.data || []) as CommissionRow[] };
  } catch (err) {
    console.error("[rep-today.commissions]", err);
    return { ok: false };
  }
}

export async function RepToday({
  tenantId,
  userId,
  teamRole,
  repName,
}: {
  tenantId: string;
  userId: string;
  teamRole: string;
  repName: string;
}) {
  const [queueRead, commissionRead] = await Promise.all([
    loadMyQueue(tenantId, userId, teamRole),
    loadMyCommissions(tenantId, userId),
  ]);

  const rows = queueRead.ok ? queueRead.value : [];
  const stages = stagesForOasisRole("agent");
  const todayKey = operatorDateKey();
  const now = Date.now();
  const dayStart = Date.parse(operatorDayStartIso());
  const dayEnd = Date.parse(operatorDayStartIso(new Date(), 1));

  type Touch = { row: TenantRecord; at: number };
  const overdue: Touch[] = [];
  const dueToday: Touch[] = [];
  const unscheduled: TenantRecord[] = [];
  const byStage = new Map<string, number>();

  for (const row of rows) {
    const data = row.data as LeadData;
    byStage.set(str(data, "stage"), (byStage.get(str(data, "stage")) || 0) + 1);
    const raw = str(data, "next_action_at");
    const at = raw ? Date.parse(raw) : NaN;
    if (!Number.isFinite(at)) {
      unscheduled.push(row);
      continue;
    }
    if (at < now) overdue.push({ row, at });
    else if (at >= dayStart && at < dayEnd) dueToday.push({ row, at });
  }
  overdue.sort((a, b) => a.at - b.at);
  dueToday.sort((a, b) => a.at - b.at);

  // "Call these first": everything already past its promised callback, then
  // everything promised for later today, then leads that have never been
  // scheduled. A rep should be able to work top-to-bottom without deciding.
  const callList: Array<{ row: TenantRecord; at: number | null; late: boolean }> = [
    ...overdue.map((t) => ({ row: t.row, at: t.at, late: true })),
    ...dueToday.map((t) => ({ row: t.row, at: t.at, late: false })),
    ...unscheduled.map((row) => ({ row, at: null, late: false })),
  ].slice(0, 8);

  const meetingsBooked = byStage.get("founder_meeting_booked") || 0;

  const commissions = commissionRead.ok ? commissionRead.value : [];
  const sumOf = (statuses: string[]) =>
    commissions
      .filter((c) => statuses.includes((c.status || "").toLowerCase()))
      .reduce((n, c) => n + (Number(c.amount) || 0), 0);
  const accrued = sumOf(["accrued"]);
  const approved = sumOf(["approved"]);
  const paid = sumOf(["paid"]);
  // Em dash on a failed read. See the file header: a zero here is a claim about
  // this person's pay, and we do not make claims we could not verify.
  const commissionValue = (n: number) => (commissionRead.ok ? money(n) : "—");

  const openerPct = Math.round(COMMISSION_MODEL.opener * 100);
  const closerPct = Math.round(COMMISSION_MODEL.openerCloser * 100);

  return (
    <div className="space-y-6 animate-fade-in">
      <PageHeader
        title="Today"
        subtitle={
          <>
            <LiveClock initialDateKey={todayKey} /> · {repName} · your book only
          </>
        }
        action={
          <Tag tone={overdue.length > 0 ? "hot" : "accent"}>
            {overdue.length > 0 ? `${overdue.length} overdue` : "on time"}
          </Tag>
        }
      />

      {!queueRead.ok && (
        <Card title="Queue unavailable">
          <EmptyState message="Your queue could not be loaded just now — this is a system fault, not an empty book. Reload in a minute; if it persists, tell CC." />
        </Card>
      )}

      <section className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Stat
          label="Calls waiting"
          value={queueRead.ok ? overdue.length + dueToday.length : "—"}
          accent={overdue.length > 0}
          hint={
            !queueRead.ok
              ? "could not read your queue"
              : overdue.length > 0
                ? `${overdue.length} past due · ${dueToday.length} scheduled today`
                : dueToday.length > 0
                  ? `${dueToday.length} scheduled today`
                  : "nothing promised for today"
          }
        />
        <Stat
          label="My open leads"
          value={queueRead.ok ? rows.length : "—"}
          hint={queueRead.ok ? "assigned to you, still workable" : "could not read your queue"}
        />
        <Stat
          label="Meetings booked"
          value={queueRead.ok ? meetingsBooked : "—"}
          hint={
            meetingsBooked > 0
              ? "waiting on the founder call"
              : "book one and it shows here"
          }
        />
        <Stat
          label="Commission accrued"
          value={commissionValue(accrued)}
          hint={
            !commissionRead.ok
              ? "could not read your commission"
              : accrued > 0
                ? "awaiting founder approval"
                : "nothing accrued yet"
          }
        />
      </section>

      <section className="grid lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2">
          <Card
            title="Call these first"
            subtitle={
              callList.length > 0
                ? `${overdue.length} past due · ${dueToday.length} due today · worked top to bottom`
                : "your callback list"
            }
            action={
              <Link
                href="/pipeline"
                className="text-xs text-fg-muted hover:text-accent transition-colors"
              >
                Full queue →
              </Link>
            }
          >
            {callList.length === 0 ? (
              queueRead.ok && rows.length === 0 ? (
                <EmptyState
                  message="No leads are assigned to you yet. That is normal on day one — CC and Adon assign researched leads into your queue, and they appear here the moment they do. Nothing is expected of you until then except reading the call guide."
                  cta={
                    <Link
                      href="/playbook/script"
                      className="inline-flex items-center gap-2 rounded-lg border border-accent/30 bg-accent-soft px-3 py-2 text-xs font-bold uppercase tracking-wider text-accent transition-colors hover:bg-accent/15"
                    >
                      <PhoneCall className="h-3.5 w-3.5" />
                      Read the call guide
                    </Link>
                  }
                />
              ) : (
                <EmptyState message="Nothing is past due and nothing is promised for today. Pick anyone from your queue and set a callback when you hang up." />
              )
            ) : (
              <ul className="divide-y divide-bg-border">
                {callList.map(({ row, at, late }) => {
                  const data = row.data as LeadData;
                  const stage = str(data, "stage");
                  const meta = stages.find((s) => s.key === stage);
                  const who =
                    str(data, "company") || str(data, "name") || str(data, "email") || "unnamed lead";
                  const disposition = str(data, "last_disposition");
                  return (
                    <li key={row.id} className="py-3">
                      <Link
                        href={`/pipeline/${row.id}`}
                        className="block -mx-2 px-2 py-1 rounded-md hover:bg-bg-elev transition-colors"
                      >
                        <div className="flex items-center gap-2">
                          {late ? (
                            <Tag tone="hot">past due</Tag>
                          ) : at === null ? (
                            <Tag tone="neutral">no callback set</Tag>
                          ) : (
                            <Tag tone="accent">today</Tag>
                          )}
                          {meta && (
                            <span className="text-[10px] uppercase tracking-wider font-bold text-fg-dim">
                              {meta.label}
                            </span>
                          )}
                          <span className="text-xs text-fg-dim ml-auto">
                            {at === null ? "never contacted" : timeAgo(new Date(at).toISOString())}
                          </span>
                        </div>
                        <div className="text-fg mt-1.5 text-sm font-semibold">
                          {truncate(who, 60)}
                        </div>
                        <div className="mt-0.5 flex items-center gap-3 text-xs text-fg-muted">
                          {str(data, "phone") && (
                            <span className="font-mono text-fg-dim">{str(data, "phone")}</span>
                          )}
                          {str(data, "name") && str(data, "company") && (
                            <span>{truncate(str(data, "name"), 28)}</span>
                          )}
                          {disposition && <span>last: {disposition.replace(/_/g, " ")}</span>}
                        </div>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
        </div>

        <div className="space-y-6">
          <Card title="My queue" subtitle="where your leads currently sit">
            {queueRead.ok && rows.length === 0 ? (
              <EmptyState message="Empty until leads are assigned to you." />
            ) : (
              <ul className="space-y-2">
                {stages.map((stage) => {
                  const n = byStage.get(stage.key) || 0;
                  return (
                    <li key={stage.key}>
                      <Link
                        href={`/pipeline?stage=${stage.key}`}
                        className="flex items-center justify-between gap-3 rounded-lg border border-bg-border bg-bg-elev/40 px-3 py-2 transition-colors hover:border-accent/40"
                      >
                        <span className="flex items-center gap-2 text-xs text-fg-muted">
                          <span
                            className="h-2 w-2 rounded-full"
                            style={{ backgroundColor: stage.bg }}
                            aria-hidden
                          />
                          {stage.label}
                        </span>
                        <span className="text-sm font-bold tabular-nums text-fg">
                          {queueRead.ok ? n : "—"}
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>

          <Card
            title="What you have earned"
            subtitle={commissionRead.ok ? "your rows only" : "read failed"}
          >
            {!commissionRead.ok ? (
              <EmptyState message="Your commission ledger could not be read. This is a fault on our side — it does not mean nothing was recorded." />
            ) : commissions.length === 0 ? (
              <EmptyState message="No commission recorded yet. It starts accruing the moment a deal you opened collects its setup payment." />
            ) : (
              <dl className="space-y-2.5">
                {[
                  { label: "Accrued", value: accrued, note: "awaiting founder approval" },
                  { label: "Approved", value: approved, note: "cleared, not yet paid" },
                  { label: "Paid", value: paid, note: "in your pocket" },
                ].map((line) => (
                  <div key={line.label} className="flex items-baseline justify-between gap-3">
                    <dt className="text-xs text-fg-muted">
                      {line.label}
                      <span className="block text-[10px] text-fg-dim">{line.note}</span>
                    </dt>
                    <dd className="text-lg font-bold tabular-nums text-fg">{money(line.value)}</dd>
                  </div>
                ))}
              </dl>
            )}
          </Card>
        </div>
      </section>

      {/*
        The comp plan, stated rather than implied. Rates and floor are read from
        COMMISSION_MODEL — the same constant the payout calculation uses — so
        this card cannot drift away from what actually gets paid. The example is
        arithmetic on the published floor, clearly labelled as such; it is a
        worked formula, not a claim about any deal.
      */}
      <Card
        title="How you get paid"
        subtitle="the whole plan, no small print"
        action={
          <Link
            href="/playbook/deals"
            className="text-xs text-fg-muted hover:text-accent transition-colors"
          >
            Full offer sheet →
          </Link>
        }
      >
        <div className="grid gap-4 md:grid-cols-3">
          <div className="rounded-lg border border-bg-border bg-bg-elev/40 p-4">
            <div className="text-[10px] uppercase tracking-[0.14em] font-bold text-fg-muted">
              You open it
            </div>
            <div className="mt-1.5 text-2xl font-bold tabular-nums text-accent">{openerPct}%</div>
            <p className="mt-1 text-xs text-fg-dim">
              You book the founder meeting, CC or Adon closes. On collected setup revenue.
            </p>
          </div>
          <div className="rounded-lg border border-bg-border bg-bg-elev/40 p-4">
            <div className="text-[10px] uppercase tracking-[0.14em] font-bold text-fg-muted">
              You open and close it
            </div>
            <div className="mt-1.5 text-2xl font-bold tabular-nums text-accent">{closerPct}%</div>
            <p className="mt-1 text-xs text-fg-dim">
              You run the deal end to end. Same collected setup revenue, half again the rate.
            </p>
          </div>
          <div className="rounded-lg border border-bg-border bg-bg-elev/40 p-4">
            <div className="text-[10px] uppercase tracking-[0.14em] font-bold text-fg-muted">
              Floor
            </div>
            <div className="mt-1.5 text-2xl font-bold tabular-nums text-fg">
              {money(COMMISSION_MODEL.floorSetup)}
            </div>
            <p className="mt-1 text-xs text-fg-dim">
              Below this collected setup there is no deal and no commission.
            </p>
          </div>
        </div>
        <p className="mt-4 flex items-start gap-2 text-xs text-fg-muted">
          <LayoutList className="mt-0.5 h-3.5 w-3.5 shrink-0 text-fg-dim" aria-hidden />
          <span>
            A {money(COMMISSION_MODEL.floorSetup)} deal pays{" "}
            <strong className="text-fg">
              {money(COMMISSION_MODEL.floorSetup * COMMISSION_MODEL.opener)}
            </strong>{" "}
            if you opened it,{" "}
            <strong className="text-fg">
              {money(COMMISSION_MODEL.floorSetup * COMMISSION_MODEL.openerCloser)}
            </strong>{" "}
            if you also closed it. Commission is on setup only, never on the monthly. Every deal
            accrues first and a founder approves the payout — nothing pays itself.
          </span>
        </p>
      </Card>
    </div>
  );
}
