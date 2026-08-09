/**
 * TextTorrent runtime RPCs, ported from PL/pgSQL to libSQL.
 *
 * The SunBiz SMS runtime (services/texttorrent-runtime, deployed as the `jarvis`
 * container) calls nine stored procedures on every tick. Their PL/pgSQL existed
 * in exactly ONE place -- the live Supabase database -- and is now preserved in
 * CEO-Agent database/rpc_sources/bravo__*texttorrent*.sql. These ports are
 * written against those extracted definitions, not against the call sites.
 *
 * consume_texttorrent_rate_token already lives in turso-rpc-shim.ts; the other
 * eight are here.
 *
 * TRANSLATION HAZARDS, all of which change behaviour if got wrong:
 *
 *  - now() in Postgres is the TRANSACTION timestamp: every reference inside one
 *    function call returns the same instant. Each port captures `nowIso` once
 *    and reuses it, rather than calling Date.now() repeatedly.
 *  - FOR UPDATE / SKIP LOCKED have no SQLite equivalent, and none is needed:
 *    SQLite serialises writers, so a single conditional UPDATE is already
 *    atomic. Every claim is expressed as one statement with RETURNING.
 *  - GET DIAGNOSTICS row_count becomes RETURNING rows, not rowsAffected. A
 *    remote driver reporting rowsAffected as -1/None would silently turn "I
 *    claimed it" into "I claimed nothing" -- rows come back if and only if rows
 *    changed.
 *  - jsonb `||` is a SHALLOW MERGE that keeps nulls. SQLite json_patch is
 *    RFC-7386 and DELETES keys whose value is null, so nulls are stripped before
 *    patching to preserve the Postgres result.
 *  - regexp_replace(x,'\D','','g') has no SQLite equivalent; digit stripping is
 *    done in JS before the value reaches SQL.
 *  - right(x,10) -> substr(x,-10); split_part(k,':',1) -> JS split.
 *  - Timestamps are ISO-8601 TEXT with a Z suffix, which compares correctly as
 *    a string, matching how the migrated schema stores them.
 */
import type { Client, InArgs } from "@libsql/client";

/** Postgres now() semantics: one instant per call, reused throughout. */
function txNow(): string {
  return new Date().toISOString();
}

function plusSeconds(iso: string, secs: number): string {
  return new Date(new Date(iso).getTime() + secs * 1000).toISOString();
}

/** right(regexp_replace(x,'\D','','g'),10) */
function last10Digits(raw: unknown): string {
  const digits = String(raw ?? "").replace(/\D/g, "");
  return digits.slice(-10);
}

function asInt(v: unknown, fallback: number): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/* ------------------------------------------------------------------ leases */

/**
 * claim_texttorrent_partition(p_partition_key, p_worker_id, p_lease_seconds)
 *
 * Source inserts a lease row selected FROM sunbiz_agent_accounts (to resolve the
 * tenant from the account id embedded in the partition key), with
 * ON CONFLICT (tenant_id, partition_key) DO UPDATE ... WHERE expired OR ours.
 * Returns row_count > 0.
 */
export async function claim_texttorrent_partition(
  client: Client,
  args: Record<string, unknown>,
): Promise<boolean> {
  const partitionKey = String(args.p_partition_key ?? "");
  const workerId = String(args.p_worker_id ?? "");
  const leaseSeconds = asInt(args.p_lease_seconds, 60);
  if (!partitionKey || !workerId) return false;

  const nowIso = txNow();
  const expiresAt = plusSeconds(nowIso, leaseSeconds);
  // split_part(p_partition_key, ':', 1) -- the account id prefix.
  const accountId = partitionKey.split(":")[0];

  // One statement, exactly like the source. The DO UPDATE ... WHERE gate is what
  // makes this a lease rather than a steal: an unexpired lease owned by someone
  // else updates nothing and RETURNING yields no row.
  const rs = await client.execute({
    sql: `
      INSERT INTO sunbiz_processing_leases
        (tenant_id, partition_key, owner_id, acquired_at, heartbeat_at, expires_at)
      SELECT a.tenant_id, :pkey, :worker, :now, :now, :expires
        FROM sunbiz_agent_accounts a
       WHERE a.id = :account_id
      ON CONFLICT(tenant_id, partition_key) DO UPDATE SET
        owner_id    = excluded.owner_id,
        acquired_at = :now,
        heartbeat_at = :now,
        expires_at  = excluded.expires_at
      WHERE sunbiz_processing_leases.expires_at < :now
         OR sunbiz_processing_leases.owner_id = :worker
      RETURNING partition_key`,
    args: {
      pkey: partitionKey,
      worker: workerId,
      now: nowIso,
      expires: expiresAt,
      account_id: accountId,
    } as InArgs,
  });
  return rs.rows.length > 0;
}

/**
 * heartbeat_texttorrent_partition(p_tenant_id, p_partition_key, p_worker_id, p_lease_seconds)
 *
 * The TENANT-SCOPED overload -- the one repository.js calls. A bare
 * (partition_key, worker_id) overload also exists in Postgres; porting that one
 * instead would silently drop tenant isolation.
 */
export async function heartbeat_texttorrent_partition(
  client: Client,
  args: Record<string, unknown>,
): Promise<boolean> {
  const tenantId = String(args.p_tenant_id ?? "");
  const partitionKey = String(args.p_partition_key ?? "");
  const workerId = String(args.p_worker_id ?? "");
  const leaseSeconds = asInt(args.p_lease_seconds, 60);
  if (!tenantId || !partitionKey || !workerId) return false;

  const nowIso = txNow();
  // `expires_at > now()` is load-bearing: a lease that already lapsed must NOT
  // be silently extended, because another worker may have taken it.
  const rs = await client.execute({
    sql: `
      UPDATE sunbiz_processing_leases
         SET heartbeat_at = :now, expires_at = :expires
       WHERE tenant_id = :tid AND partition_key = :pkey
         AND owner_id = :worker AND expires_at > :now
      RETURNING partition_key`,
    args: {
      now: nowIso,
      expires: plusSeconds(nowIso, leaseSeconds),
      tid: tenantId,
      pkey: partitionKey,
      worker: workerId,
    } as InArgs,
  });
  return rs.rows.length > 0;
}

/**
 * release_texttorrent_partition(p_tenant_id, p_partition_key, p_worker_id)
 * Tenant-scoped overload. Deletes only OUR lease.
 */
export async function release_texttorrent_partition(
  client: Client,
  args: Record<string, unknown>,
): Promise<boolean> {
  const tenantId = String(args.p_tenant_id ?? "");
  const partitionKey = String(args.p_partition_key ?? "");
  const workerId = String(args.p_worker_id ?? "");
  if (!tenantId || !partitionKey || !workerId) return false;

  const rs = await client.execute({
    sql: `
      DELETE FROM sunbiz_processing_leases
       WHERE tenant_id = :tid AND partition_key = :pkey AND owner_id = :worker
      RETURNING partition_key`,
    args: { tid: tenantId, pkey: partitionKey, worker: workerId } as InArgs,
  });
  return rs.rows.length > 0;
}

/* ------------------------------------------------------------- inbound work */

/**
 * claim_texttorrent_inbound(p_account_id, p_worker_id, p_lease_seconds)
 * RETURNS SETOF texttorrent_inbound_work -- the claimed row, or nothing.
 *
 * This is the guard that stops two workers answering the same inbound SMS.
 * Postgres used FOR UPDATE SKIP LOCKED; SQLite serialises writers so the
 * subselect + conditional UPDATE is atomic on its own.
 */
export async function claim_texttorrent_inbound(
  client: Client,
  args: Record<string, unknown>,
): Promise<unknown[]> {
  const accountId = String(args.p_account_id ?? "");
  const workerId = String(args.p_worker_id ?? "");
  const leaseSeconds = asInt(args.p_lease_seconds, 60);
  if (!accountId || !workerId) return [];

  const nowIso = txNow();
  const rs = await client.execute({
    sql: `
      UPDATE texttorrent_inbound_work
         SET status = 'running', lease_owner = :worker,
             claimed_at = :now, lease_expires_at = :expires
       WHERE id = (
         SELECT id FROM texttorrent_inbound_work
          WHERE account_id = :account_id
            AND (status = 'pending'
                 OR (status = 'running' AND lease_expires_at < :now))
            AND next_attempt_at <= :now
          ORDER BY priority ASC, created_at ASC
          LIMIT 1)
      RETURNING *`,
    args: {
      worker: workerId,
      now: nowIso,
      expires: plusSeconds(nowIso, leaseSeconds),
      account_id: accountId,
    } as InArgs,
  });
  return rs.rows.map((r) => ({ ...r }));
}

/**
 * fail_texttorrent_inbound(p_work_id, p_worker_id, p_error_code, p_max_attempts, p_next_attempt_at)
 * RETURNS text -- the new status, or null when the guard rejects.
 */
export async function fail_texttorrent_inbound(
  client: Client,
  args: Record<string, unknown>,
): Promise<string | null> {
  const workId = String(args.p_work_id ?? "");
  const workerId = String(args.p_worker_id ?? "");
  const errorCode = args.p_error_code == null ? "" : String(args.p_error_code);
  const maxAttempts = asInt(args.p_max_attempts, 0);
  const nextAttemptAt = args.p_next_attempt_at ? String(args.p_next_attempt_at) : null;

  // Source: `if p_max_attempts < 1 or p_error_code is null or '' then return null`
  if (maxAttempts < 1 || !errorCode) return null;

  const nowIso = txNow();

  // The source SELECT ... FOR UPDATE only matches a row we currently hold.
  const cur = await client.execute({
    sql: `SELECT id, tenant_id, account_id, attempts, provider_message_id, next_attempt_at
            FROM texttorrent_inbound_work
           WHERE id = :id AND status = 'running' AND lease_owner = :worker`,
    args: { id: workId, worker: workerId } as InArgs,
  });
  if (cur.rows.length === 0) return null;
  const w = cur.rows[0] as Record<string, unknown>;

  const nextAttempts = asInt(w.attempts, 0) + 1;
  const nextStatus = nextAttempts >= maxAttempts ? "dead_letter" : "pending";
  const truncated = errorCode.slice(0, 120); // left(p_error_code,120)

  if (nextStatus === "dead_letter") {
    // ON CONFLICT DO NOTHING -- a second failure must not blow up the call.
    await client.execute({
      sql: `
        INSERT INTO texttorrent_dead_letters
          (inbound_work_id, tenant_id, account_id, failure_code, attempts, sanitized_metadata)
        VALUES (:wid, :tid, :aid, :code, :attempts, :meta)
        ON CONFLICT DO NOTHING`,
      args: {
        wid: w.id as string,
        tid: w.tenant_id as string,
        aid: w.account_id as string,
        code: truncated,
        attempts: nextAttempts,
        meta: JSON.stringify({ provider_message_id: w.provider_message_id ?? null }),
      } as InArgs,
    });
  }

  await client.execute({
    sql: `
      UPDATE texttorrent_inbound_work
         SET status = :status,
             attempts = :attempts,
             next_attempt_at = CASE WHEN :status = 'pending'
                                    THEN :next_attempt ELSE next_attempt_at END,
             lease_owner = NULL,
             lease_expires_at = NULL,
             last_error = :code,
             completed_at = CASE WHEN :status = 'dead_letter' THEN :now ELSE NULL END
       WHERE id = :id`,
    args: {
      status: nextStatus,
      attempts: nextAttempts,
      // coalesce(p_next_attempt_at, now())
      next_attempt: nextAttemptAt ?? nowIso,
      code: truncated,
      now: nowIso,
      id: w.id as string,
    } as InArgs,
  });

  return nextStatus;
}

/**
 * texttorrent_runtime_health(p_worker_id) RETURNS jsonb
 * Pure aggregation -- no writes, no lease semantics.
 */
export async function texttorrent_runtime_health(
  client: Client,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const workerId = String(args.p_worker_id ?? "");
  const nowIso = txNow();

  const rs = await client.execute({
    sql: `
      SELECT
        (SELECT COUNT(*) FROM sunbiz_processing_leases
          WHERE owner_id = :worker AND expires_at > :now)            AS active_leases,
        (SELECT COUNT(*) FROM texttorrent_inbound_work
          WHERE status = 'pending')                                  AS pending,
        (SELECT COUNT(*) FROM texttorrent_inbound_work
          WHERE status = 'running')                                  AS running,
        (SELECT COUNT(*) FROM texttorrent_dead_letters
          WHERE resolved_at IS NULL)                                 AS dead,
        (SELECT MIN(created_at) FROM texttorrent_inbound_work
          WHERE status = 'pending')                                  AS oldest_pending_at`,
    args: { worker: workerId, now: nowIso } as InArgs,
  });
  const r = (rs.rows[0] ?? {}) as Record<string, unknown>;
  return {
    worker_id: workerId,
    now: nowIso,
    active_leases: Number(r.active_leases ?? 0),
    pending: Number(r.pending ?? 0),
    running: Number(r.running ?? 0),
    dead: Number(r.dead ?? 0),
    oldest_pending_at: r.oldest_pending_at ?? null,
  };
}

/* ------------------------------------------------- suppression + finalize */

/**
 * suppress_texttorrent_inbound(p_inbound_work_id, p_tenant_id, p_account_id, p_reason, p_worker_id)
 *
 * Opt-out handling: record the suppression, park the conversation, cancel any
 * pending sends to that number, and close the work item. Returns false (writing
 * nothing) if the row is not ours or the phone is unusable -- the source checks
 * the phone BEFORE any write, and so does this.
 */
export async function suppress_texttorrent_inbound(
  client: Client,
  args: Record<string, unknown>,
): Promise<boolean> {
  const workId = String(args.p_inbound_work_id ?? "");
  const tenantId = String(args.p_tenant_id ?? "");
  const accountId = String(args.p_account_id ?? "");
  const reason = String(args.p_reason ?? "");
  const workerId = String(args.p_worker_id ?? "");

  const nowIso = txNow();

  const cur = await client.execute({
    sql: `SELECT id, tenant_id, account_id, conversation,
                 provider_conversation_id, provider_message_id
            FROM texttorrent_inbound_work
           WHERE id = :id AND tenant_id = :tid AND account_id = :aid
             AND status = 'running' AND lease_owner = :worker`,
    args: { id: workId, tid: tenantId, aid: accountId, worker: workerId } as InArgs,
  });
  if (cur.rows.length === 0) return false;
  const w = cur.rows[0] as Record<string, unknown>;

  let conv: Record<string, unknown> = {};
  try {
    conv = typeof w.conversation === "string"
      ? JSON.parse(w.conversation as string)
      : ((w.conversation as Record<string, unknown>) ?? {});
  } catch {
    conv = {};
  }

  const phone10 = last10Digits(conv.to_phone);
  if (phone10.length !== 10) return false; // guard precedes every write

  await client.execute({
    sql: `
      INSERT INTO sunbiz_phone_suppressions
        (tenant_id, phone_last10, reason, source, source_work_id, updated_at)
      VALUES (:tid, :phone, :reason, 'texttorrent_runtime', :wid, :now)
      ON CONFLICT(tenant_id, phone_last10) DO UPDATE SET
        reason = excluded.reason, source = excluded.source,
        source_work_id = excluded.source_work_id, updated_at = :now`,
    args: {
      tid: w.tenant_id as string, phone: phone10, reason,
      wid: w.id as string, now: nowIso,
    } as InArgs,
  });

  const convId = (w.provider_conversation_id as string) ?? (w.provider_message_id as string);
  const leadId = conv.lead_id ? String(conv.lead_id) : null;

  await client.execute({
    sql: `
      INSERT INTO sunbiz_conversation_state
        (tenant_id, provider, provider_conversation_id, lead_id, agent_account_id,
         qualification_state, last_intent, last_action, automation_paused,
         knowledge_version, updated_at)
      SELECT :tid, 'texttorrent', :conv_id, :lead_id, :aid,
             '{}', :reason, 'suppressed', 1, a.knowledge_version, :now
        FROM sunbiz_agent_accounts a WHERE a.id = :aid
      ON CONFLICT(tenant_id, provider, provider_conversation_id) DO UPDATE SET
        last_intent = excluded.last_intent,
        last_action = 'suppressed',
        automation_paused = 1,
        updated_at = :now`,
    args: {
      tid: w.tenant_id as string, conv_id: convId, lead_id: leadId,
      aid: w.account_id as string, reason, now: nowIso,
    } as InArgs,
  });

  // Cancel queued sends matching the thread OR the same last-10 digits. The
  // digit comparison is done with substr since SQLite has no regexp_replace;
  // to_phone values are stored normalised, and the thread_key arm catches the
  // rest.
  await client.execute({
    sql: `
      UPDATE scheduled_sends SET status = 'cancelled'
       WHERE tenant_id = :tid AND channel = 'sms' AND status = 'pending'
         AND (thread_key = :thread_key
              OR substr(replace(replace(replace(replace(COALESCE(to_phone,''),
                    '-',''),' ',''),'(',''),')',''), -10) = :phone)`,
    args: {
      tid: w.tenant_id as string,
      thread_key: conv.thread_key ? String(conv.thread_key) : null,
      phone: phone10,
    } as InArgs,
  });

  await client.execute({
    sql: `
      UPDATE texttorrent_inbound_work
         SET status = 'suppressed', decision = :decision, lease_owner = NULL,
             lease_expires_at = NULL, completed_at = :now, last_error = NULL
       WHERE id = :id`,
    args: {
      decision: JSON.stringify({ intent: reason, shouldSuppress: true }),
      now: nowIso, id: w.id as string,
    } as InArgs,
  });

  return true;
}

/**
 * finalize_texttorrent_inbound(p_work_id, p_worker_id, p_status, p_decision)
 *
 * The end of a successful tick: record the conversation state, optionally stage
 * a reply draft, close the work item, and publish an agent event. Five tables.
 *
 * THREE BEHAVIOURS THAT LOOK LIKE BUGS AND ARE NOT -- all preserved verbatim,
 * because "tidying" any of them changes what operators see:
 *
 * 1. `drafted` with a blank response returns FALSE, and does so AFTER the
 *    conversation-state upsert has already been written. PL/pgSQL `return
 *    false` does not roll back, and PostgREST commits the statement, so in
 *    production that partial write persists. Replicated exactly. Making it
 *    atomic here would be a silent behaviour change, and the caller
 *    (worker.js) treats false as "retry", which would then double-write.
 *
 * 2. qualification_state merges with jsonb `||`, a SHALLOW merge that KEEPS
 *    null values. SQLite's json_patch is RFC-7386 and DELETES null-valued keys,
 *    so it is NOT a substitute. The merge is therefore done in JS with a spread,
 *    which matches `||` exactly, including nulls.
 *
 * 3. human_owner_id uses coalesce(excluded, existing): an escalation records the
 *    owner, and a later `drafted` pass must NOT clear it.
 */
export async function finalize_texttorrent_inbound(
  client: Client,
  args: Record<string, unknown>,
): Promise<boolean> {
  const workId = String(args.p_work_id ?? "");
  const workerId = String(args.p_worker_id ?? "");
  const status = String(args.p_status ?? "");

  // Source guard: only these two statuses finalize anything.
  if (status !== "drafted" && status !== "escalated") return false;

  let decision: Record<string, unknown> = {};
  const rawDecision = args.p_decision;
  try {
    decision = typeof rawDecision === "string"
      ? JSON.parse(rawDecision)
      : ((rawDecision as Record<string, unknown>) ?? {});
  } catch {
    decision = {};
  }

  const nowIso = txNow();

  // SELECT ... FOR UPDATE: only a row we currently hold.
  const wq = await client.execute({
    sql: `SELECT id, tenant_id, account_id, conversation, provider_conversation_id,
                 provider_message_id, source_interaction_id
            FROM texttorrent_inbound_work
           WHERE id = :id AND status = 'running' AND lease_owner = :worker`,
    args: { id: workId, worker: workerId } as InArgs,
  });
  if (wq.rows.length === 0) return false;
  const w = wq.rows[0] as Record<string, unknown>;

  const aq = await client.execute({
    sql: `SELECT id, handoff_user_id, knowledge_version
            FROM sunbiz_agent_accounts WHERE id = :aid AND tenant_id = :tid`,
    args: { aid: w.account_id as string, tid: w.tenant_id as string } as InArgs,
  });
  if (aq.rows.length === 0) return false;
  const a = aq.rows[0] as Record<string, unknown>;

  let conv: Record<string, unknown> = {};
  try {
    conv = typeof w.conversation === "string"
      ? JSON.parse(w.conversation as string)
      : ((w.conversation as Record<string, unknown>) ?? {});
  } catch {
    conv = {};
  }

  const convId = (w.provider_conversation_id as string) ?? (w.provider_message_id as string);
  const leadId = conv.lead_id ? String(conv.lead_id) : null;
  const intent = decision.intent == null ? null : String(decision.intent);
  const humanOwner = status === "escalated" ? (a.handoff_user_id ?? null) : null;

  // qualification_state = existing || excluded. Read the existing value so the
  // merge can be done with JS spread semantics (see note 2 above).
  const existing = await client.execute({
    sql: `SELECT id, qualification_state, human_owner_id
            FROM sunbiz_conversation_state
           WHERE tenant_id = :tid AND provider = 'texttorrent'
             AND provider_conversation_id = :cid`,
    args: { tid: w.tenant_id as string, cid: convId } as InArgs,
  });

  const incoming = (decision.qualification_updates as Record<string, unknown>) ?? {};
  let stateId: string;

  if (existing.rows.length > 0) {
    const prev = existing.rows[0] as Record<string, unknown>;
    let prevState: Record<string, unknown> = {};
    try {
      prevState = typeof prev.qualification_state === "string"
        ? JSON.parse(prev.qualification_state as string)
        : ((prev.qualification_state as Record<string, unknown>) ?? {});
    } catch {
      prevState = {};
    }
    const merged = { ...prevState, ...incoming };   // exactly jsonb `||`
    stateId = String(prev.id);
    await client.execute({
      sql: `UPDATE sunbiz_conversation_state
               SET qualification_state = :qs, last_intent = :intent,
                   last_action = :action,
                   human_owner_id = COALESCE(:owner, human_owner_id),
                   knowledge_version = :kv, updated_at = :now
             WHERE id = :id`,
      args: {
        qs: JSON.stringify(merged), intent, action: status,
        owner: humanOwner as string | null,
        kv: (a.knowledge_version as string) ?? null, now: nowIso, id: stateId,
      } as InArgs,
    });
  } else {
    const ins = await client.execute({
      sql: `INSERT INTO sunbiz_conversation_state
              (tenant_id, provider, provider_conversation_id, lead_id,
               agent_account_id, qualification_state, last_intent, last_action,
               automation_paused, human_owner_id, knowledge_version, updated_at)
            VALUES (:tid, 'texttorrent', :cid, :lead_id, :aid, :qs, :intent,
                    :action, 0, :owner, :kv, :now)
            RETURNING id`,
      args: {
        tid: w.tenant_id as string, cid: convId, lead_id: leadId,
        aid: w.account_id as string, qs: JSON.stringify(incoming),
        intent, action: status, owner: humanOwner as string | null,
        kv: (a.knowledge_version as string) ?? null, now: nowIso,
      } as InArgs,
    });
    stateId = String((ins.rows[0] as Record<string, unknown>).id);
  }

  // response := nullif(btrim(p_decision->>'response'),'')
  const response = String(decision.response ?? "").trim();

  if (status === "drafted" && response) {
    await client.execute({
      sql: `INSERT INTO sunbiz_reply_drafts
              (tenant_id, conversation_state_id, agent_account_id, lead_id,
               thread_key, to_phone, original_text, intent, confidence,
               model_id, model_version, knowledge_version,
               source_interaction_id, provider_message_id)
            VALUES (:tid, :state_id, :aid, :lead_id, :thread_key, :to_phone,
                    :text, :intent, :confidence, :model_id, :model_version,
                    :kv, :src, :pmid)
            ON CONFLICT(tenant_id, source_interaction_id) DO NOTHING`,
      args: {
        tid: w.tenant_id as string, state_id: stateId,
        aid: w.account_id as string, lead_id: leadId,
        thread_key: conv.thread_key ? String(conv.thread_key) : null,
        to_phone: conv.to_phone ? String(conv.to_phone) : null,
        text: response.slice(0, 1600),                 // left(response,1600)
        intent: intent ?? "UNCERTAIN",                 // coalesce(...,'UNCERTAIN')
        confidence: decision.confidence == null || decision.confidence === ""
          ? null : Number(decision.confidence),
        model_id: decision.model_id == null ? null : String(decision.model_id),
        model_version: decision.model_version == null ? null : String(decision.model_version),
        kv: (a.knowledge_version as string) ?? null,
        src: (w.source_interaction_id as string) ?? null,
        pmid: (w.provider_message_id as string) ?? null,
      } as InArgs,
    });
  } else if (status === "drafted") {
    // Blank response on a draft: the source returns here WITHOUT closing the
    // work item, leaving the state upsert above committed. See note 1.
    return false;
  }

  await client.execute({
    sql: `UPDATE texttorrent_inbound_work
             SET status = :status, decision = :decision, lease_owner = NULL,
                 lease_expires_at = NULL, completed_at = :now, last_error = NULL
           WHERE id = :id`,
    args: {
      status, decision: JSON.stringify(decision), now: nowIso,
      id: w.id as string,
    } as InArgs,
  });

  await client.execute({
    sql: `INSERT INTO agent_events
            (event_type, publisher_agent, severity, payload, correlation_id)
          VALUES (:event_type, 'texttorrent-runtime', :severity, :payload, :corr)`,
    args: {
      event_type: status === "drafted"
        ? "TEXTTORRENT_DRAFT_READY" : "TEXTTORRENT_HANDOFF_REQUIRED",
      severity: status === "drafted" ? "info" : "warn",
      payload: JSON.stringify({
        tenant_id: w.tenant_id, account_id: w.account_id, work_id: w.id,
        conversation_state_id: stateId, intent,
      }),
      corr: String(w.tenant_id),
    } as InArgs,
  });

  return true;
}

export const TEXTTORRENT_RPCS = {
  claim_texttorrent_partition,
  heartbeat_texttorrent_partition,
  release_texttorrent_partition,
  claim_texttorrent_inbound,
  fail_texttorrent_inbound,
  finalize_texttorrent_inbound,
  suppress_texttorrent_inbound,
  texttorrent_runtime_health,
};
