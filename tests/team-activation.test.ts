/**
 * tests/team-activation.test.ts — deactivating a teammate (2026-09-24).
 *
 * CC retired the OASIS sales team and asked for reps to be DEACTIVATED, not
 * deleted: gone from every live list, unable to sign in, history intact, and
 * reactivatable from Settings. These assertions execute the rules that make
 * that true and pin the wiring that keeps every surface on the same roster.
 *
 * Run: node --conditions=react-server --import tsx tests/team-activation.test.ts
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";

import {
  BOARD_ON_DEACTIVATION,
  DEACTIVATION_BAN_UNTIL,
  POOL_ON_DEACTIVATION,
  boardUnassignPatch,
  dispositionForStage,
  planLeadDisposition,
} from "../lib/team-activation-rules";
import { CURRENT_OASIS_PIPELINE_CYCLE, isInPipelineCycle } from "../lib/pipeline-cycle";
import { OASIS_LEAD_STAGE_KEYS } from "../lib/oasis-stage-meta";
import { canonicalizeTenantMembers, isActiveMember, type MemberRow } from "../lib/team";

// ── 1. Every lifecycle stage has exactly one disposition ─────────────────────
{
  // CC's choice, 2026-09-24: warm conversations stay on the board, early work
  // returns to the pool, closed/delivery records keep their owner.
  const expected: Record<string, string> = {
    researched: "pool",
    assigned: "pool",
    attempting_contact: "pool",
    connected: "board",
    qualified: "board",
    founder_meeting_booked: "board",
    demo_completed: "board",
    proposal_sent: "board",
    won: "keep",
    lost: "keep",
    onboarding: "keep",
    in_build: "keep",
    client_review: "keep",
    launched: "keep",
  };
  for (const stage of OASIS_LEAD_STAGE_KEYS) {
    assert.ok(stage in expected, `stage ${stage} was added without deciding its deactivation disposition`);
    assert.equal(dispositionForStage(stage), expected[stage], `disposition for ${stage}`);
  }
  assert.equal(dispositionForStage(undefined), "pool", "a stageless legacy lead is prospect inventory");
  assert.equal(dispositionForStage(" Qualified "), "board", "stage keys are normalised");
  for (const key of POOL_ON_DEACTIVATION) assert.equal(BOARD_ON_DEACTIVATION.has(key), false);
}

// ── 2. The plan partitions without losing or duplicating a lead ──────────────
{
  const plan = planLeadDisposition([
    { id: "a", data: { stage: "assigned" } },
    { id: "b", data: { stage: "connected" } },
    { id: "c", data: { stage: "won" } },
    { id: "d", data: null },
    { id: "e", data: { stage: "founder_meeting_booked" } },
  ]);
  assert.deepEqual(plan, { pool: ["a", "d"], board: ["b", "e"], keep: ["c"] });
}

// ── 3. A warm lead left on the board stays VISIBLE on the board ─────────────
{
  // The board shows only rows inside the current revenue cycle. A lead assigned
  // before the boundary would vanish the moment its owner is cleared unless the
  // patch stamps the cycle explicitly.
  const before = {
    stage: "qualified",
    assigned_to: "rep-1",
    assigned_at: "2026-08-01T00:00:00.000Z",
    collaborators: ["rep-2"],
  };
  assert.equal(isInPipelineCycle({ data: before }), false, "precondition: an old assignment is outside the cycle");
  const patched = {
    ...before,
    ...boardUnassignPatch({
      previousOwner: "rep-1",
      nowIso: "2026-09-24T12:00:00.000Z",
      cycleId: CURRENT_OASIS_PIPELINE_CYCLE.id,
    }),
  };
  assert.equal(patched.assigned_to, null);
  assert.deepEqual(patched.collaborators, [], "the retired rep's collaborator grants go with them");
  assert.equal(patched.unassigned_from, "rep-1", "who held it is recorded, not lost");
  assert.equal(isInPipelineCycle({ data: patched }), true, "the unassigned warm lead must stay on the board");
}

// ── 4. Active filtering happens AFTER canonicalization ───────────────────────
{
  const row = (over: Partial<MemberRow>): MemberRow => ({
    id: "x",
    auth_user_id: "u1",
    email: "rep@oasisai.work",
    full_name: "Rep",
    display_name: null,
    team_role: "opener",
    is_owner: false,
    admin_access: false,
    invited_by: null,
    joined_at: "2026-01-01T00:00:00.000Z",
    ...over,
  });
  assert.equal(isActiveMember(row({})), true);
  assert.equal(isActiveMember(row({ deactivated_at: "2026-09-24T00:00:00.000Z" })), false);
  const members = canonicalizeTenantMembers([
    row({ id: "a", auth_user_id: "u1" }),
    row({ id: "b", auth_user_id: "u2", email: "gone@oasisai.work", deactivated_at: "2026-09-24T00:00:00.000Z" }),
  ]).filter(isActiveMember);
  assert.deepEqual(members.map((m) => m.id), ["a"]);

  // Duplicates of ONE person (same login): the deactivated row is richer — an
  // admin role and a display name — so it outscored the live row before the
  // fix, took it out in the dedup, and the person vanished from every roster.
  const sameLogin = canonicalizeTenantMembers([
    row({ id: "a-live", auth_user_id: "u9", team_role: "opener" }),
    row({
      id: "0-retired",
      auth_user_id: "u9",
      team_role: "admin",
      display_name: "Rep",
      deactivated_at: "2026-09-24T00:00:00.000Z",
    }),
  ]);
  assert.deepEqual(sameLogin.map((m) => m.id), ["a-live"], "the live row must win the dedup");
  assert.deepEqual(sameLogin.filter(isActiveMember).map((m) => m.id), ["a-live"]);
}

// ── 5. Wiring: every live roster excludes inactive people ────────────────────
{
  const team = readFileSync("lib/team.ts", "utf8");
  const assignmentRoster = team.slice(team.indexOf("export async function getOasisPipelineAssignmentRoster"));
  assert.match(assignmentRoster, /isActiveMember\(member\)/, "assign menus + server checks must drop inactive people");
  assert.match(
    team.slice(team.indexOf("export async function getOasisSalesRepRoster")),
    /isActiveMember\(member\)/,
    "the sales roster (chips, scorecard, commissions, manager scope) must drop inactive people",
  );
  assert.match(
    team.slice(team.indexOf("export async function getTenantMembers")),
    /options\.includeInactive \? members : members\.filter\(isActiveMember\)/,
    "getTenantMembers defaults to active-only",
  );

  const pipeline = readFileSync("app/pipeline/page.tsx", "utf8");
  assert.match(pipeline, /activeMemberIds\.has\(id\)/, "board rep chips must come from ACTIVE members only");

  const google = readFileSync("app/api/auth/google/callback/route.ts", "utf8");
  assert.equal((google.match(/banned_until/g) || []).length >= 2, true, "Google sign-in must refuse banned accounts");

  const activation = readFileSync("lib/team-activation.ts", "utf8");
  assert.match(activation, /session_version = session_version \+ 1/, "deactivation must kill open sessions");
  assert.match(activation, /banned_until = \?/, "deactivation must block sign-in");
  assert.match(activation, /WHERE id = \? AND banned_until = \?/, "reactivation lifts only our own ban");
  assert.match(activation, /activeElsewhere/, "a login still active in another workspace is not banned");
  assert.equal(DEACTIVATION_BAN_UNTIL.startsWith("9999-"), true);
}

// ── 6. Deactivation acts on the PERSON, not the clicked row (executed) ───────
// Pre-cutover duplicate profiles share a login or an email. Deactivating one
// row used to leave the other live on the roster and, when it carried a
// different login, able to sign in. Runs the real I/O against a libSQL file.
async function personLevelDeactivation(): Promise<void> {
  const dbFile = join(mkdtempSync(join(tmpdir(), "team-activation-")), "test.db");
  process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
  process.env.TURSO_DB_PATH = dbFile;

  const { WEBDEV_TENANT_ID } = await import("../lib/web-leads/tenant");
  const { getTenantMembers, getOasisSalesRepRoster } = await import("../lib/team");
  const { activationErrorStatus, deactivateMember, previewDeactivation, reactivateMember } = await import(
    "../lib/team-activation"
  );
  const OTHER_TENANT = "0b7c6a1e-5f7d-4c55-9d0e-3a1f2b4c5d6e";
  const OTHER_BAN = "2030-01-01T00:00:00.000Z";

  const db = createClient({ url: `file:${dbFile}` });
  await db.executeMultiple(`
    CREATE TABLE user_profiles (
      id TEXT PRIMARY KEY, auth_user_id TEXT, email TEXT NOT NULL, full_name TEXT NOT NULL,
      display_name TEXT, tenant_id TEXT, team_role TEXT NOT NULL DEFAULT 'member',
      is_owner INTEGER NOT NULL DEFAULT 0, admin_access INTEGER NOT NULL DEFAULT 0,
      invited_by TEXT, joined_at TEXT, manager_user_id TEXT,
      deactivated_at TEXT, deactivated_by TEXT, deactivation_reason TEXT
    );
    CREATE TABLE "_supabase_auth_users" (
      id TEXT PRIMARY KEY, email TEXT, banned_until TEXT,
      session_version INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE tenant_records (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, entity_type TEXT NOT NULL,
      data TEXT, created_at TEXT, updated_at TEXT
    );
    CREATE TABLE lead_interactions (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      tenant_id TEXT, lead_id TEXT, type TEXT, channel TEXT, direction TEXT,
      agent_source TEXT, actor_user_id TEXT, subject TEXT, content TEXT,
      content_preview TEXT, metadata TEXT, created_at TEXT
    );
    CREATE TABLE website_sales_commissions (
      id TEXT PRIMARY KEY, tenant_id TEXT, rep_user_id TEXT, status TEXT
    );
    CREATE TABLE tenant_audit_log (
      id TEXT PRIMARY KEY, tenant_id TEXT, actor_user_id TEXT, actor_email TEXT,
      action_type TEXT NOT NULL, target_table TEXT, target_id TEXT, before TEXT,
      after TEXT, ip_hash TEXT, user_agent TEXT, metadata TEXT, created_at TEXT
    );
  `);

  const profile = async (p: {
    id: string;
    auth: string | null;
    email: string;
    tenant?: string;
    role?: string;
    owner?: boolean;
    display?: string | null;
    deactivatedAt?: string | null;
  }) =>
    db.execute({
      sql: `INSERT INTO user_profiles
              (id, auth_user_id, email, full_name, display_name, tenant_id, team_role, is_owner, joined_at, deactivated_at)
            VALUES (?, ?, ?, 'Rep Person', ?, ?, ?, ?, '2026-01-01T00:00:00.000Z', ?)`,
      args: [
        p.id,
        p.auth,
        p.email,
        p.display ?? null,
        p.tenant ?? WEBDEV_TENANT_ID,
        p.role ?? "opener",
        p.owner ? 1 : 0,
        p.deactivatedAt ?? null,
      ],
    });
  const login = async (id: string, bannedUntil: string | null = null) =>
    db.execute({
      sql: `INSERT INTO "_supabase_auth_users" (id, email, banned_until) VALUES (?, ?, ?)`,
      args: [id, `${id}@login.test`, bannedUntil],
    });
  const lead = async (id: string, assignedTo: string, stage: string) =>
    db.execute({
      sql: `INSERT INTO tenant_records (id, tenant_id, entity_type, data, created_at, updated_at)
            VALUES (?, ?, 'lead', ?, '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')`,
      args: [id, WEBDEV_TENANT_ID, JSON.stringify({ name: id, assigned_to: assignedTo, stage })],
    });
  const profileState = async (id: string) =>
    (await db.execute({ sql: "SELECT deactivated_at FROM user_profiles WHERE id = ?", args: [id] })).rows[0]
      ?.deactivated_at ?? null;
  const loginState = async (id: string) => {
    const r = (
      await db.execute({
        sql: `SELECT banned_until, session_version FROM "_supabase_auth_users" WHERE id = ?`,
        args: [id],
      })
    ).rows[0];
    return { bannedUntil: r?.banned_until ?? null, sessionVersion: Number(r?.session_version) };
  };
  const leadOwner = async (id: string) => {
    const r = (await db.execute({ sql: "SELECT data FROM tenant_records WHERE id = ?", args: [id] })).rows[0];
    return (JSON.parse(String(r?.data)) as { assigned_to?: string | null }).assigned_to ?? null;
  };

  // The founder acting, plus an old duplicate row carrying the founder's login.
  await profile({ id: "p-founder", auth: "auth-founder", email: "conaugh@oasisai.work", role: "owner", owner: true });
  await profile({ id: "p-founder-old", auth: "auth-founder", email: "old-founder@oasisai.work" });
  await login("auth-founder");
  const actor = {
    authUserId: "auth-founder",
    profileId: "p-founder",
    tenantId: WEBDEV_TENANT_ID,
    teamRole: "owner" as const,
    isOwner: true,
    adminAccess: true,
  };

  // Person S: same login twice. The deactivated row is richer (admin, display
  // name) and sorts first by id — it used to win the dedup and hide the person.
  await profile({ id: "p-s-live", auth: "auth-s", email: "sam@oasisai.work" });
  await profile({
    id: "p-s-0-retired",
    auth: "auth-s",
    email: "sam@oasisai.work",
    role: "admin",
    display: "Sam",
    deactivatedAt: "2026-09-01T00:00:00.000Z",
  });
  // Retired on purpose, earlier, by someone else — its own stamp and reason.
  await db.execute(
    "UPDATE user_profiles SET deactivated_by = 'p-cleanup', deactivation_reason = 'legacy dup cleanup' WHERE id = 'p-s-0-retired'",
  );
  await login("auth-s");

  // Person P: same email, TWO different logins.
  await profile({ id: "p-dup-a", auth: "auth-a", email: "Dup@OasisAI.work" });
  await profile({ id: "p-dup-b", auth: "auth-b", email: " dup@oasisai.work " });
  await login("auth-a");
  await login("auth-b");
  await lead("lead-a-cold", "auth-a", "assigned");
  await lead("lead-b-warm", "auth-b", "qualified");
  await lead("lead-b-won", "auth-b", "won");
  await db.executeMultiple(`
    INSERT INTO website_sales_commissions VALUES ('c1', '${WEBDEV_TENANT_ID}', 'auth-a', 'accrued');
    INSERT INTO website_sales_commissions VALUES ('c2', '${WEBDEV_TENANT_ID}', 'auth-b', 'approved');
    INSERT INTO website_sales_commissions VALUES ('c3', '${WEBDEV_TENANT_ID}', 'auth-b', 'paid');
  `);

  // Person Q: same email, two logins — one of them still works in another
  // workspace and carries somebody else's (non-deactivation) ban.
  await profile({ id: "p-q-1", auth: "auth-q1", email: "quinn@oasisai.work" });
  await profile({ id: "p-q-2", auth: "auth-q2", email: "quinn@oasisai.work" });
  await profile({ id: "p-q-other", auth: "auth-q2", email: "quinn@oasisai.work", tenant: OTHER_TENANT });
  await login("auth-q1");
  await login("auth-q2", OTHER_BAN);

  // X and Z are two teammates on the roster; Y is X's duplicate (same login)
  // that happens to carry Z's email. The roster's dedup is greedy: Y folds into
  // X by login and never claims its email, so Z stays a separate person.
  await profile({ id: "p-x", auth: "auth-x1", email: "xavier@oasisai.work" });
  await profile({ id: "p-y", auth: "auth-x1", email: "yolanda@oasisai.work" });
  await profile({ id: "p-z", auth: "auth-z", email: "yolanda@oasisai.work" });
  await login("auth-x1");
  await login("auth-z");
  await lead("lead-x-warm", "auth-x1", "qualified");
  await lead("lead-z-cold", "auth-z", "assigned");
  await db.execute(
    `INSERT INTO website_sales_commissions VALUES ('c4', '${WEBDEV_TENANT_ID}', 'auth-z', 'accrued')`,
  );
  const profileRow = async (id: string) =>
    (
      await db.execute({
        sql: "SELECT deactivated_at, deactivated_by, deactivation_reason FROM user_profiles WHERE id = ?",
        args: [id],
      })
    ).rows[0];

  // 6a. The live row survives canonicalization in the REAL roster reads.
  const liveIds = (await getTenantMembers(WEBDEV_TENANT_ID)).map((m) => m.id);
  assert.ok(liveIds.includes("p-s-live"), "an active duplicate must keep the person on the live roster");
  assert.equal(liveIds.includes("p-s-0-retired"), false);
  const repIds = (await getOasisSalesRepRoster(WEBDEV_TENANT_ID)).map((m) => m.id);
  assert.ok(repIds.includes("p-s-live"), "the sales roster must keep the person through their live row");

  // 6b. The owner guard sees every row of the person: a duplicate carrying the
  // founder's login is the founder, so it is refused and nothing changes.
  await assert.rejects(
    deactivateMember({ tenantId: WEBDEV_TENANT_ID, targetProfileId: "p-founder-old", actor }),
    (err: unknown) => err instanceof Error && err.message === "cannot_deactivate_owner" && activationErrorStatus(err) === 409,
  );
  assert.equal(await profileState("p-founder-old"), null);
  assert.equal((await loginState("auth-founder")).bannedUntil, null, "the founder's login must never be banned");

  // 6c. Preview counts the whole person: leads and commissions of BOTH logins.
  const preview = await previewDeactivation({ tenantId: WEBDEV_TENANT_ID, targetProfileId: "p-dup-a", actor });
  assert.equal(preview.active, true);
  assert.equal(preview.leadHandling, true);
  assert.deepEqual(preview.leads, { pool: 1, board: 1, keep: 1 });
  assert.equal(preview.unpaidCommissions, 2, "accrued + approved across both logins; paid is not unpaid");

  // 6d. Deactivate through ONE row: both rows go inactive, both logins banned.
  const result = await deactivateMember({
    tenantId: WEBDEV_TENANT_ID,
    targetProfileId: "p-dup-a",
    actor,
    reason: "test",
  });
  assert.equal(result.loginBlocked, true);
  assert.equal(result.loginNote, null);
  assert.equal(result.released, 1);
  assert.equal(result.boardUnassigned, 1);
  assert.deepEqual(result.refused, []);
  assert.deepEqual(result.impact.leads, { pool: 1, board: 1, keep: 1 });
  assert.ok(await profileState("p-dup-a"), "the clicked row is deactivated");
  assert.ok(await profileState("p-dup-b"), "the duplicate row with the other login is deactivated too");
  for (const id of ["auth-a", "auth-b"]) {
    const state = await loginState(id);
    assert.equal(state.bannedUntil, DEACTIVATION_BAN_UNTIL, `${id} must be banned`);
    assert.equal(state.sessionVersion, 1, `${id}'s open sessions must be killed`);
  }
  assert.equal(await leadOwner("lead-a-cold"), null, "login A's cold lead returns to the pool");
  assert.equal(await leadOwner("lead-b-warm"), null, "login B's warm lead is unassigned on the board");
  assert.equal(await leadOwner("lead-b-won"), "auth-b", "a won lead keeps its owner for history");
  const liveAfter = (await getTenantMembers(WEBDEV_TENANT_ID)).map((m) => m.id);
  assert.equal(liveAfter.some((id) => id === "p-dup-a" || id === "p-dup-b"), false, "gone from the live roster");
  assert.ok(
    (await getTenantMembers(WEBDEV_TENANT_ID, { includeInactive: true })).some((m) => m.id === "p-dup-a" || m.id === "p-dup-b"),
    "still visible to history views",
  );
  const audit = (
    await db.execute({
      sql: "SELECT target_id, after FROM tenant_audit_log WHERE action_type = 'member.deactivate'",
      args: [],
    })
  ).rows;
  assert.equal(audit.length, 1);
  assert.equal(audit[0].target_id, "p-dup-a");
  assert.deepEqual(
    [...(JSON.parse(String(audit[0].after)) as { profile_ids: string[] }).profile_ids].sort(),
    ["p-dup-a", "p-dup-b"],
  );

  // 6e. Reactivate restores both rows and lifts both of OUR bans.
  const back = await reactivateMember({ tenantId: WEBDEV_TENANT_ID, targetProfileId: "p-dup-b", actor });
  assert.equal(back.loginRestored, true);
  assert.equal(await profileState("p-dup-a"), null);
  assert.equal(await profileState("p-dup-b"), null);
  for (const id of ["auth-a", "auth-b"]) {
    assert.equal((await loginState(id)).bannedUntil, null, `${id} can sign in again`);
  }

  // 6f. A login still active in another workspace is not banned, the result
  // says so, and reactivation never lifts a ban it did not place.
  const q = await deactivateMember({ tenantId: WEBDEV_TENANT_ID, targetProfileId: "p-q-1", actor });
  assert.equal(q.loginBlocked, false, "one login left open is not a blocked person");
  assert.equal(q.loginNote, "1 of 2 logins kept: still active in another workspace");
  assert.ok(await profileState("p-q-1"));
  assert.ok(await profileState("p-q-2"));
  assert.equal(await profileState("p-q-other"), null, "another workspace's profile is untouched");
  assert.equal((await loginState("auth-q1")).bannedUntil, DEACTIVATION_BAN_UNTIL);
  assert.deepEqual(await loginState("auth-q2"), { bannedUntil: OTHER_BAN, sessionVersion: 0 });
  await reactivateMember({ tenantId: WEBDEV_TENANT_ID, targetProfileId: "p-q-2", actor });
  assert.equal((await loginState("auth-q1")).bannedUntil, null);
  assert.equal((await loginState("auth-q2")).bannedUntil, OTHER_BAN, "somebody else's ban stays");

  // 6g. Reactivation undoes ONE deactivation. Sam's stale admin duplicate was
  // retired on purpose before; reviving it with the live row would let the
  // richer stale row win the dedup and knock Sam off the sales roster as an
  // "admin". It must keep its own stamp through the whole cycle.
  await deactivateMember({ tenantId: WEBDEV_TENANT_ID, targetProfileId: "p-s-live", actor, reason: "retired" });
  assert.ok(await profileState("p-s-live"));
  assert.deepEqual(
    { ...(await profileRow("p-s-0-retired")) },
    { deactivated_at: "2026-09-01T00:00:00.000Z", deactivated_by: "p-cleanup", deactivation_reason: "legacy dup cleanup" },
    "an already-retired duplicate keeps its original stamp",
  );
  assert.equal((await loginState("auth-s")).bannedUntil, DEACTIVATION_BAN_UNTIL);
  // With every row inactive the Team page shows the richer stale row — that
  // is the id an admin clicks to reactivate Sam.
  const shownSam = (await getTenantMembers(WEBDEV_TENANT_ID, { includeInactive: true })).find(
    (m) => m.auth_user_id === "auth-s",
  );
  assert.equal(shownSam?.id, "p-s-0-retired");
  const samBack = await reactivateMember({ tenantId: WEBDEV_TENANT_ID, targetProfileId: "p-s-0-retired", actor });
  assert.equal(samBack.loginRestored, true);
  assert.equal(await profileState("p-s-live"), null, "the row this deactivation stamped comes back");
  assert.equal(await profileState("p-s-0-retired"), "2026-09-01T00:00:00.000Z", "the stale duplicate stays retired");
  assert.equal((await loginState("auth-s")).bannedUntil, null);
  const samLive = (await getTenantMembers(WEBDEV_TENANT_ID)).filter((m) => m.auth_user_id === "auth-s");
  assert.deepEqual(samLive.map((m) => [m.id, m.team_role]), [["p-s-live", "opener"]], "Sam is back with his live role");
  assert.ok(
    (await getOasisSalesRepRoster(WEBDEV_TENANT_ID)).some((m) => m.id === "p-s-live"),
    "Sam is back on the sales roster",
  );
  // Reactivating a person who is already active undoes nothing — it must not
  // reach past the live row and revive the stale one.
  const again = await reactivateMember({ tenantId: WEBDEV_TENANT_ID, targetProfileId: "p-s-0-retired", actor });
  assert.equal(again.loginRestored, false);
  assert.equal(await profileState("p-s-0-retired"), "2026-09-01T00:00:00.000Z");

  // 6h. The person is the teammate the roster shows, not a transitive closure
  // over logins and emails. Deactivating X takes X's duplicate Y with it, but
  // never Z — whom the Team page lists as somebody else — nor Z's login.
  const rosterXYZ = (await getTenantMembers(WEBDEV_TENANT_ID)).map((m) => m.id);
  assert.ok(rosterXYZ.includes("p-x") && rosterXYZ.includes("p-z"), "precondition: X and Z are two teammates");
  assert.equal(rosterXYZ.includes("p-y"), false, "precondition: Y is folded into X");
  const previewX = await previewDeactivation({ tenantId: WEBDEV_TENANT_ID, targetProfileId: "p-x", actor });
  assert.deepEqual(previewX.leads, { pool: 0, board: 1, keep: 0 }, "Z's lead is not X's");
  assert.equal(previewX.unpaidCommissions, 0, "Z's commission is not X's");
  const x = await deactivateMember({ tenantId: WEBDEV_TENANT_ID, targetProfileId: "p-x", actor });
  assert.equal(x.loginBlocked, true);
  assert.ok(await profileState("p-x"));
  assert.ok(await profileState("p-y"), "X's duplicate (same login) goes with X");
  assert.equal(await profileState("p-z"), null, "Z is somebody else and stays active");
  assert.equal((await loginState("auth-x1")).bannedUntil, DEACTIVATION_BAN_UNTIL);
  assert.deepEqual(await loginState("auth-z"), { bannedUntil: null, sessionVersion: 0 }, "Z can still sign in");
  assert.equal(await leadOwner("lead-x-warm"), null);
  assert.equal(await leadOwner("lead-z-cold"), "auth-z", "Z's lead is untouched");
  const rosterAfterX = (await getTenantMembers(WEBDEV_TENANT_ID)).map((m) => m.id);
  assert.ok(rosterAfterX.includes("p-z"));
  assert.equal(rosterAfterX.includes("p-x") || rosterAfterX.includes("p-y"), false);
  await reactivateMember({ tenantId: WEBDEV_TENANT_ID, targetProfileId: "p-x", actor });
  assert.equal(await profileState("p-x"), null);
  assert.equal(await profileState("p-y"), null);
  assert.equal((await loginState("auth-x1")).bannedUntil, null);

  // 6i. Cross-linked leftover: row "a" carries P's email but teammate B's
  // login. Reactivating P's row must restore P — the grouping sees B's live
  // row through "a", and before this it reported success while restoring
  // nothing (P stayed inactive, P's login stayed banned).
  await profile({ id: "p-i-1p", auth: "auth-ip", email: "pat@oasisai.work" });
  await profile({ id: "p-i-2a", auth: "auth-ib", email: "pat@oasisai.work" });
  await profile({ id: "p-i-3b", auth: "auth-ib", email: "bea@oasisai.work" });
  await login("auth-ip");
  await login("auth-ib");
  await deactivateMember({ tenantId: WEBDEV_TENANT_ID, targetProfileId: "p-i-1p", actor });
  assert.ok(await profileState("p-i-1p"));
  assert.equal(await profileState("p-i-3b"), null, "B is somebody else and stays active");
  await reactivateMember({ tenantId: WEBDEV_TENANT_ID, targetProfileId: "p-i-1p", actor });
  assert.equal(await profileState("p-i-1p"), null, "P's own row comes back");
  assert.equal((await loginState("auth-ip")).bannedUntil, null, "P can sign in again");
  assert.equal((await loginState("auth-ib")).bannedUntil, null, "B's login was never touched");

  db.close();
}

personLevelDeactivation()
  .then(() => console.log("team-activation: all assertions passed"))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
