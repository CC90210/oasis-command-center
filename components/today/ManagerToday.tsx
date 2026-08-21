/**
 * ManagerToday — the sales manager's dashboard.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS COMPONENT HAD TO EXIST BEFORE THE MANAGER ROLE COULD SHIP
 * ─────────────────────────────────────────────────────────────────────────────
 * app/page.tsx dispatches Today by persona, and every persona without a branch
 * falls through to FounderToday. When the `manager` persona was added, it fell
 * through — and although the MONEY was safe (FounderToday takes
 * `showFinancials`, which is false for a manager), FounderToday consults no
 * other capability. A manager would have seen the entire tenant's pipeline and
 * the company inbound tape, both of which their capability record explicitly
 * denies.
 *
 * That is the exact failure lib/role-surfaces.ts was written to prevent,
 * reintroduced by adding a persona without a surface. A capability flag that no
 * component reads is a comment.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TEAM IS A THIRD SCOPE, AND IT IS THE POINT
 * ─────────────────────────────────────────────────────────────────────────────
 * A manager sees the reps who roll up to them (user_profiles.manager_user_id =
 * me) and nothing else. Not "all", which would hand them CC's own book; not
 * "own", which would make them unable to manage. Every query below is scoped by
 * that roster, and when the roster is empty the queries do not run at all.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * AN ABSENT ANSWER IS NOT A ZERO
 * ─────────────────────────────────────────────────────────────────────────────
 * Same discipline as RepToday: a failed read renders as "couldn't load", never
 * as 0. A manager who sees "$0 team commission" when the query actually failed
 * will go and have a conversation with a rep about a number that was never
 * real.
 */

import Link from "next/link";
import { Card, EmptyState, PageHeader, Stat } from "@/components/Card";
import { LiveClock } from "@/components/LiveClock";
import { getServiceSupabase } from "@/lib/supabase-server";
import { operatorDateKey } from "@/lib/dates";
import { MANAGER_OVERRIDE_BPS } from "@/lib/website-sales-comp";

/** A read that can fail. `ok:false` means "could not find out", which is not zero. */
type Read<T> = { ok: true; value: T } | { ok: false };

type RepRow = { auth_user_id: string; display_name: string | null; full_name: string | null; team_role: string | null };
type LineRow = { rep_user_id: string | null; amount_cents: number | null };

// Two decimals, always. maximumFractionDigits: 0 rounded 150 cents to "$2" —
// on a page whose entire job is telling someone what they earned.
const money = (cents: number) =>
  `$${(cents / 100).toLocaleString("en-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

async function loadTeam(tenantId: string, managerUserId: string): Promise<Read<RepRow[]>> {
  try {
    const db = getServiceSupabase();
    const r = await db
      .from("user_profiles")
      .select("auth_user_id, display_name, full_name, team_role")
      .eq("tenant_id", tenantId)
      .eq("manager_user_id", managerUserId)
      // One level, never recursive: nothing stops a profile naming itself as
      // its own manager, and a recursive roll-up would not terminate.
      .order("auth_user_id", { ascending: true });
    if (r.error) return { ok: false };
    return { ok: true, value: (r.data || []) as RepRow[] };
  } catch {
    return { ok: false };
  }
}

/** Enough headroom for a real team, plus one row so truncation is DETECTABLE
 *  rather than silent. See the guard below. */
const LINE_PAGE = 2_000;

async function loadTeamLines(tenantId: string, repIds: string[]): Promise<Read<LineRow[]>> {
  // No roster, no query. Sending an empty `in` list is how "this manager has no
  // reps" quietly becomes "every row in the tenant" on some clients.
  if (repIds.length === 0) return { ok: true, value: [] };
  try {
    const db = getServiceSupabase();
    const r = await db
      .from("website_sales_commissions")
      .select("rep_user_id, amount_cents")
      .eq("tenant_id", tenantId)
      .eq("entry_type", "accrual")
      // LIVE ROWS ONLY. Without this the total counts commissions that were
      // clawed back: a refund moves the accrual to status='offset' and writes a
      // negative refund_offset row, and entry_type='accrual' alone keeps the
      // original. A manager would see money on the board that the company
      // reclaimed weeks ago, and coach against a number that is not real.
      .in("status", ["accrued", "approved", "paid"])
      .in("rep_user_id", repIds)
      .order("id", { ascending: true })
      .limit(LINE_PAGE + 1);
    if (r.error) return { ok: false };
    const rows = (r.data || []) as LineRow[];
    // A CAP THAT BINDS IS A WRONG TOTAL, NOT A SMALL ONE. Reading a fixed page
    // and summing it renders a partial figure as a complete one — the manager
    // sees "team commission: $18,400" with no hint that rows were dropped. If
    // the cap is reached we report a FAILED read instead, because "couldn't
    // load" is honest and a truncated total is not.
    if (rows.length > LINE_PAGE) return { ok: false };
    return { ok: true, value: rows };
  } catch {
    return { ok: false };
  }
}

async function loadMyOverride(tenantId: string, managerUserId: string): Promise<Read<number>> {
  try {
    const db = getServiceSupabase();
    const r = await db
      .from("website_sales_commissions")
      .select("amount_cents")
      .eq("tenant_id", tenantId)
      .eq("rep_user_id", managerUserId)
      .eq("party_role", "manager")
      .in("status", ["accrued", "approved", "paid"])
      .order("id", { ascending: true })
      .limit(LINE_PAGE + 1);
    if (r.error) return { ok: false };
    if ((r.data || []).length > LINE_PAGE) return { ok: false };
    const total = (r.data || []).reduce(
      (s: number, row: { amount_cents: number | null }) => s + Number(row.amount_cents ?? 0),
      0,
    );
    return { ok: true, value: total };
  } catch {
    return { ok: false };
  }
}

export async function ManagerToday({
  tenantId,
  userId,
  managerName,
}: {
  tenantId: string;
  userId: string;
  managerName: string;
}) {
  const dateKey = operatorDateKey();
  const teamRead = await loadTeam(tenantId, userId);
  const repIds = teamRead.ok ? teamRead.value.map((r) => r.auth_user_id).filter(Boolean) : [];
  const [rawLinesRead, overrideRead] = await Promise.all([
    loadTeamLines(tenantId, repIds),
    loadMyOverride(tenantId, userId),
  ]);

  // THIS FILE'S OWN HEADER SAYS AN ABSENT ANSWER IS NOT A ZERO, and the first
  // version broke that rule three lines after stating it. When loadTeam fails,
  // repIds is [] — and loadTeamLines answers an empty roster with a SUCCESSFUL
  // empty result, so the card rendered a confident "$0.00" for a team whose
  // roster we could not even read. A manager would go and ask a rep why they
  // earned nothing this month.
  //
  // An unknown roster makes the team total unknowable. Say so.
  const linesRead: Read<LineRow[]> = teamRead.ok ? rawLinesRead : { ok: false };

  const byRep = new Map<string, number>();
  if (linesRead.ok) {
    for (const l of linesRead.value) {
      if (!l.rep_user_id) continue;
      byRep.set(l.rep_user_id, (byRep.get(l.rep_user_id) ?? 0) + Number(l.amount_cents ?? 0));
    }
  }
  const teamTotal = [...byRep.values()].reduce((s, v) => s + v, 0);
  const nameOf = (r: RepRow) => r.display_name || r.full_name || r.auth_user_id.slice(0, 8);

  return (
    <div className="space-y-6 animate-fade-in">
      <PageHeader
        title="Today"
        subtitle={
          <span>
            {managerName} · <LiveClock initialDateKey={dateKey} /> · your team
          </span>
        }
      />

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Stat
          label="Reps reporting to you"
          value={teamRead.ok ? String(teamRead.value.length) : "—"}
          hint={teamRead.ok ? "assigned via their profile" : "couldn't load your roster"}
        />
        <Stat
          label="Team commission (accrued)"
          value={linesRead.ok ? money(teamTotal) : "—"}
          hint={linesRead.ok ? "what your reps have earned" : "couldn't load — this is not $0"}
        />
        <Stat
          label="Your override"
          value={overrideRead.ok ? money(overrideRead.value) : "—"}
          hint={`${(MANAGER_OVERRIDE_BPS / 100).toFixed(0)}% of what OASIS retains`}
        />
      </div>

      <Card
        title="Your team"
        subtitle="Everyone whose profile names you as their manager."
      >
        {!teamRead.ok ? (
          <EmptyState message="Couldn't load your roster. This read failed — it does not mean you have no reps. Reload in a minute." />
        ) : teamRead.value.length === 0 ? (
          <EmptyState message="No reps are assigned to you yet. An admin assigns reps by setting you as their manager; until then this board stays empty." />
        ) : (
          <div className="divide-y divide-bg-border">
            {teamRead.value.map((rep) => (
              <div key={rep.auth_user_id} className="flex items-center justify-between py-2.5">
                <div className="min-w-0">
                  <div className="text-sm text-fg truncate">{nameOf(rep)}</div>
                  <div className="text-xs text-fg-dim">{rep.team_role ?? "—"}</div>
                </div>
                <div className="text-sm font-semibold text-fg tabular-nums">
                  {linesRead.ok ? money(byRep.get(rep.auth_user_id) ?? 0) : "—"}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card
        title="Coaching"
        subtitle="Your team's pipeline, scoped to the reps above."
      >
        <EmptyState
          message="Your board shows the leads assigned to you and your reps — not the whole tenant."
          cta={
            <Link href="/pipeline" className="btn-secondary inline-flex items-center gap-2 !px-3 !py-1.5 text-xs">
              Go to pipeline
            </Link>
          }
        />
      </Card>
    </div>
  );
}
