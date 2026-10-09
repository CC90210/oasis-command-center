/**
 * lib/skills/store.ts - Skills Training storage (JARVIS plan 2; Turso bravo-empire, skills_*).
 *
 * Every function takes the libSQL Client (as lib/playbook/store.ts does), so the tests run them
 * against a temp file with the real migration. Turso has no RLS: ownership is a code property,
 * and every admin read and write here is filtered by owner_user_id from the SESSION, never by
 * a value from the request body.
 */
import "server-only";
import { randomBytes } from "node:crypto";
import type { Client, InStatement } from "@libsql/client";
import { sha256 } from "@/lib/api-helpers";
import { getTursoClient, tursoConfigured } from "@/lib/turso";
import type { Op, Report, SkillRow } from "./contract";

export function skillsDb(): Client | null {
  return tursoConfigured() ? getTursoClient() : null;
}

const nowIso = () => new Date().toISOString();
const str = (v: unknown) => (v === null || v === undefined ? null : String(v));
const num = (v: unknown) => Number(v ?? 0);
const newKey = (computerId: string) => `skc_${computerId}_${randomBytes(32).toString("base64url")}`;

// ---- machine side (authenticated by lib/skills/machine-auth.ts) ----

export async function pollState(db: Client, computerId: string): Promise<{ rebuild_requested: boolean; pending: number }> {
  const c = await db.execute({ sql: "SELECT rebuild_requested_at FROM skills_computer WHERE id = ?", args: [computerId] });
  const p = await db.execute({
    sql: "SELECT COUNT(*) AS n FROM skills_change_status WHERE computer_id = ? AND status IN ('waiting', 'accepted-anyway')",
    args: [computerId],
  });
  return { rebuild_requested: Boolean(c.rows[0]?.rebuild_requested_at), pending: num(p.rows[0]?.n) };
}

export async function storeSkills(db: Client, computerId: string, push: { skills_sha: string; skills: SkillRow[] }): Promise<number> {
  const t = nowIso();
  const stmts: InStatement[] = [
    { sql: "DELETE FROM skills_skill WHERE computer_id = ?", args: [computerId] },
    ...push.skills.map((s) => ({
      sql: `INSERT INTO skills_skill (computer_id, name, description, kind, quarantined, capabilities_json, example_prompts_json, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [computerId, s.name, s.description, s.kind, s.quarantined ? 1 : 0, JSON.stringify(s.capabilities), JSON.stringify(s.example_prompts), t],
    })),
    { sql: "UPDATE skills_computer SET skills_sha = ? WHERE id = ?", args: [push.skills_sha, computerId] },
  ];
  await db.batch(stmts, "write");
  return push.skills.length;
}

export type PendingChange = { id: string; description: string; author: string; scope: string; ops: Op[]; status: "waiting" | "accepted-anyway" };

export async function pendingChanges(db: Client, computerId: string): Promise<PendingChange[]> {
  // Ordered by created_at then rowid (not id): ids are ch-<Date.now()>-<random>, so two
  // changes created in the same millisecond would otherwise come back in random order.
  const rs = await db.execute({
    sql: `SELECT c.id, c.description, c.author, c.scope, c.ops_json, s.status
          FROM skills_change_status s JOIN skills_change c ON c.id = s.change_id
          WHERE s.computer_id = ? AND s.status IN ('waiting', 'accepted-anyway')
          ORDER BY c.created_at, c.rowid`,
    args: [computerId],
  });
  return rs.rows.map((r) => ({
    id: String(r.id), description: String(r.description), author: String(r.author), scope: String(r.scope),
    ops: JSON.parse(String(r.ops_json)) as Op[], status: String(r.status) as PendingChange["status"],
  }));
}

/**
 * Apply a check-in report. Each result is compare-and-set on the status the PC PULLED: if Adon
 * decided in the meantime (or this is a re-sent report), the row has moved on and is skipped;
 * his decision wins. Prunes become applied system changes with deterministic ids, so a re-sent
 * report adds nothing. The rebuild flag is cleared only if it was raised before the run started.
 */
export async function recordReport(db: Client, computerId: string, report: Report): Promise<{ updated: number; skipped: number }> {
  const t = nowIso();
  let updated = 0;
  let skipped = 0;
  for (const r of report.results) {
    const rs = await db.execute({
      sql: `UPDATE skills_change_status SET status = ?, reason = ?, worse = ?, better = ?, totals_json = ?, updated_at = ?
            WHERE change_id = ? AND computer_id = ? AND status = ?`,
      args: [r.status, r.reason, r.worse, r.better, JSON.stringify(r.totals), t, r.change_id, computerId, r.pulled_status],
    });
    if (rs.rowsAffected === 1) updated += 1;
    else skipped += 1;
  }
  const stmts: InStatement[] = [];
  for (const p of report.pruned) {
    const id = `prune-${sha256(`${computerId}|${p.skill}|${p.label}`).slice(0, 16)}`;
    stmts.push({
      sql: `INSERT OR IGNORE INTO skills_change (id, author, description, scope, ops_json, created_at) VALUES (?, 'system', ?, ?, ?, ?)`,
      args: [id, `Removed ${p.skill} from ${p.label}: ${p.why}`, computerId, JSON.stringify([{ op: "unassign", skill: p.skill, label: p.label }]), t],
    });
    stmts.push({
      sql: `INSERT OR IGNORE INTO skills_change_status (change_id, computer_id, status, reason, updated_at) VALUES (?, ?, 'applied', ?, ?)`,
      args: [id, computerId, p.why, t],
    });
  }
  if (report.labels) {
    stmts.push({ sql: "DELETE FROM skills_label WHERE computer_id = ?", args: [computerId] });
    for (const l of report.labels.labels) {
      stmts.push({
        sql: `INSERT INTO skills_label (computer_id, id, level, parent_id, name, meaning, examples_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [computerId, l.id, l.level, l.parent, l.name, l.meaning, JSON.stringify(l.examples), t],
      });
    }
    stmts.push({ sql: "DELETE FROM skills_skill_label WHERE computer_id = ?", args: [computerId] });
    for (const a of report.labels.assignments) {
      stmts.push({
        sql: `INSERT OR REPLACE INTO skills_skill_label (computer_id, skill, label_id, rank, updated_at) VALUES (?, ?, ?, ?, ?)`,
        args: [computerId, a.skill, a.label, a.rank, t],
      });
    }
  }
  stmts.push({
    sql: `UPDATE skills_computer SET last_checkin_at = ?, last_checkin_outcome = ?, last_checkin_detail = ?,
            rebuild_requested_at = CASE WHEN rebuild_requested_at IS NOT NULL AND rebuild_requested_at <= ? THEN NULL ELSE rebuild_requested_at END
          WHERE id = ?`,
    args: [report.run.finished_at, report.run.outcome, report.run.detail, report.run.started_at, computerId],
  });
  await db.batch(stmts, "write");
  return { updated, skipped };
}

// ---- admin side (Adon's session; owner = viewer.userId) ----

export async function createComputer(db: Client, owner: string, displayName: string): Promise<{ id: string; key: string }> {
  const id = `pc-${randomBytes(4).toString("hex")}`;
  const key = newKey(id);
  const t = nowIso();
  await db.execute({
    sql: `INSERT INTO skills_computer (id, display_name, owner_user_id, is_primary, key_hash, key_issued_at, created_at)
          VALUES (?, ?, ?, CASE WHEN EXISTS (SELECT 1 FROM skills_computer WHERE is_primary = 1) THEN 0 ELSE 1 END, ?, ?, ?)`,
    args: [id, displayName, owner, sha256(key), t, t],
  });
  return { id, key };
}

export async function issueKey(db: Client, owner: string, id: string): Promise<string | null> {
  const key = newKey(id);
  const rs = await db.execute({
    sql: "UPDATE skills_computer SET key_hash = ?, key_issued_at = ?, revoked_at = NULL WHERE id = ? AND owner_user_id = ?",
    args: [sha256(key), nowIso(), id, owner],
  });
  return rs.rowsAffected === 1 ? key : null;
}

export async function revokeComputer(db: Client, owner: string, id: string): Promise<boolean> {
  const rs = await db.execute({
    sql: "UPDATE skills_computer SET key_hash = NULL, revoked_at = ? WHERE id = ? AND owner_user_id = ?",
    args: [nowIso(), id, owner],
  });
  return rs.rowsAffected === 1;
}

export async function createChange(
  db: Client, owner: string, author: string, ch: { description: string; scope: string; ops: Op[] },
): Promise<{ ok: true; id: string } | { ok: false; error: "not_allowed" }> {
  let targets: string[];
  if (ch.scope === "shared") {
    // Only Adon edits the shared map (spec decision 5): the owner of the primary computer.
    const p = await db.execute({ sql: "SELECT 1 FROM skills_computer WHERE is_primary = 1 AND owner_user_id = ?", args: [owner] });
    if (!p.rows.length) return { ok: false, error: "not_allowed" };
    targets = (await db.execute("SELECT id FROM skills_computer ORDER BY created_at")).rows.map((r) => String(r.id));
  } else {
    const c = await db.execute({ sql: "SELECT 1 FROM skills_computer WHERE id = ? AND owner_user_id = ?", args: [ch.scope, owner] });
    if (!c.rows.length) return { ok: false, error: "not_allowed" };
    targets = [ch.scope];
  }
  const id = `ch-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
  const t = nowIso();
  await db.batch(
    [
      { sql: "INSERT INTO skills_change (id, author, description, scope, ops_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        args: [id, author, ch.description, ch.scope, JSON.stringify(ch.ops), t] },
      ...targets.map((cid) => ({
        sql: "INSERT INTO skills_change_status (change_id, computer_id, status, updated_at) VALUES (?, ?, 'waiting', ?)",
        args: [id, cid, t],
      })),
    ],
    "write",
  );
  return { ok: true, id };
}

export async function decide(
  db: Client, owner: string, actor: string, changeId: string, computerId: string, decision: "accept-anyway" | "reject",
): Promise<"ok" | "not_found" | "not_held"> {
  const own = await db.execute({ sql: "SELECT 1 FROM skills_computer WHERE id = ? AND owner_user_id = ?", args: [computerId, owner] });
  if (!own.rows.length) return "not_found";
  const rs = await db.execute({
    sql: `UPDATE skills_change_status SET status = ?, decided_by = ?, updated_at = ?
          WHERE change_id = ? AND computer_id = ? AND status = 'held'`,
    args: [decision === "accept-anyway" ? "accepted-anyway" : "rejected", actor, nowIso(), changeId, computerId],
  });
  if (rs.rowsAffected === 1) return "ok";
  const ex = await db.execute({ sql: "SELECT 1 FROM skills_change_status WHERE change_id = ? AND computer_id = ?", args: [changeId, computerId] });
  return ex.rows.length ? "not_held" : "not_found";
}

export async function requestRebuild(db: Client, owner: string, computerId: string): Promise<boolean> {
  const rs = await db.execute({
    sql: "UPDATE skills_computer SET rebuild_requested_at = ? WHERE id = ? AND owner_user_id = ? AND revoked_at IS NULL",
    args: [nowIso(), computerId, owner],
  });
  return rs.rowsAffected === 1;
}

export async function overview(db: Client, owner: string) {
  const comps = await db.execute({
    sql: `SELECT id, display_name, is_primary, revoked_at, rebuild_requested_at, last_checkin_at, last_checkin_outcome, last_checkin_detail
          FROM skills_computer WHERE owner_user_id = ? ORDER BY created_at`,
    args: [owner],
  });
  const ch = await db.execute({
    sql: `SELECT s.change_id, s.computer_id, s.status, s.reason, s.worse, s.better, s.totals_json, s.updated_at,
                 c.description, c.author, c.scope, c.created_at
          FROM skills_change_status s
          JOIN skills_change c ON c.id = s.change_id
          JOIN skills_computer k ON k.id = s.computer_id
          WHERE k.owner_user_id = ?
          ORDER BY s.updated_at DESC, s.change_id LIMIT 500`,
    args: [owner],
  });
  return {
    computers: comps.rows.map((r) => ({
      id: String(r.id), display_name: String(r.display_name), primary: num(r.is_primary) === 1, revoked: Boolean(r.revoked_at),
      rebuild_requested: Boolean(r.rebuild_requested_at), last_checkin_at: str(r.last_checkin_at),
      last_checkin_outcome: str(r.last_checkin_outcome), last_checkin_detail: str(r.last_checkin_detail),
    })),
    changes: ch.rows.map((r) => ({
      change_id: String(r.change_id), computer_id: String(r.computer_id), status: String(r.status), reason: String(r.reason),
      worse: num(r.worse), better: num(r.better), totals: JSON.parse(String(r.totals_json)) as Record<string, unknown>,
      updated_at: String(r.updated_at), description: String(r.description), author: String(r.author), scope: String(r.scope),
      created_at: String(r.created_at),
    })),
  };
}
