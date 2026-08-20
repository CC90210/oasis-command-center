/**
 * turso-rpc-shim — PL/pgSQL RPC ports over @libsql/client.
 *
 * Each function is a port of database/rpc_sources/<project>__<name>.sql from
 * the Business-Empire-Agent repo (the extracted live sources). Ports were
 * machine-generated with per-RPC adversarial review where the review pass
 * completed; VERIFICATION STATE PER RPC is recorded in the manifest at the
 * bottom — treat "ported-unverified" entries with the same suspicion as any
 * untested code and prefer verifying before first production use.
 *
 * Dispatched from getServiceSupabase()'s hybrid rpc handler: shim first, then
 * TURSO_RPC_PASSTHROUGH, else TURSO_RPC_BLOCKED.
 */

import type { Client } from "@libsql/client";

export async function approve_sunbiz_draft(client: Client, args: Record<string, unknown>): Promise<unknown> {
  const p_draft_id = typeof args.p_draft_id === "string" ? args.p_draft_id : null;
  const p_tenant_id = typeof args.p_tenant_id === "string" ? args.p_tenant_id : null;
  const p_user_id = typeof args.p_user_id === "string" ? args.p_user_id : null;
  const p_final_text = typeof args.p_final_text === "string" ? args.p_final_text : null;

  // if p_final_text is null or char_length(btrim(p_final_text)) not between 1 and 1600 then return null
  // NB: Postgres btrim() with no char list trims SPACES only (not all whitespace, so no .trim()),
  // and char_length counts code points (so no .length on the raw string).
  if (p_final_text === null) return null;
  const finalText = p_final_text.replace(/^ +/, "").replace(/ +$/, "");
  const finalLen = Array.from(finalText).length;
  if (finalLen < 1 || finalLen > 1600) return null;

  // NULL uuid params can never match a row in the PG source either -> return null (fail closed)
  if (p_draft_id === null || p_tenant_id === null || p_user_id === null) return null;

  const nowIso = new Date().toISOString();
  // date_trunc('day', now()) — Supabase server runs UTC; ISO TEXT compares lexicographically = chronologically
  const dayStartUtc = nowIso.slice(0, 10) + "T00:00:00.000Z";
  const digitsOnly = (s: string) => s.replace(/\D/g, "");

  // select * into d from sunbiz_reply_drafts where id=$1 and tenant_id=$2 and status='pending' for update
  const draftRs = await client.execute({
    sql: `SELECT id, tenant_id, agent_account_id, lead_id, thread_key, to_phone, source_interaction_id
          FROM sunbiz_reply_drafts
          WHERE id = ? AND tenant_id = ? AND status = 'pending'`,
    args: [p_draft_id, p_tenant_id],
  });
  if (draftRs.rows.length === 0) return null;
  const d = draftRs.rows[0] as Record<string, unknown>;

  // select * into a from sunbiz_agent_accounts where id=d.agent_account_id and tenant_id=$2
  //   and enabled=true and mode='semi' for update   (booleans stored as 0/1)
  const acctRs = await client.execute({
    sql: `SELECT id, tenant_id, user_id, from_number, daily_cap
          FROM sunbiz_agent_accounts
          WHERE id = ? AND tenant_id = ? AND enabled = 1 AND mode = 'semi'`,
    args: [d.agent_account_id as string, p_tenant_id],
  });
  if (acctRs.rows.length === 0) return null;
  const a = acctRs.rows[0] as Record<string, unknown>;

  // approver must be the account owner, or a tenant owner/admin in user_profiles
  if (a.user_id !== p_user_id) {
    const adminRs = await client.execute({
      sql: `SELECT 1 FROM user_profiles
            WHERE tenant_id = ? AND auth_user_id = ?
              AND (is_owner = 1 OR team_role IN ('owner','admin'))
            LIMIT 1`,
      args: [p_tenant_id, p_user_id],
    });
    if (adminRs.rows.length === 0) return null;
  }

  // phone10 := right(regexp_replace(d.to_phone,'\D','','g'),10)
  const phone10 = digitsOnly(String(d.to_phone ?? "")).slice(-10);

  // suppression check (re-verified atomically inside the write batch below)
  const suppRs = await client.execute({
    sql: `SELECT 1 FROM sunbiz_phone_suppressions WHERE tenant_id = ? AND phone_last10 = ? LIMIT 1`,
    args: [p_tenant_id, phone10],
  });
  if (suppRs.rows.length > 0) return null;

  // stale-draft check: any inbound interaction newer than the source interaction, for the same
  // lead or same normalized last-10 phone -> refuse. Phone normalization needs regex, so the
  // per-row comparison happens in JS. (source lookup is by PK only — no tenant predicate in the PG source)
  if (d.source_interaction_id != null) {
    const srcRs = await client.execute({
      sql: `SELECT coalesce(sent_at, created_at) AS ts FROM lead_interactions WHERE id = ?`,
      args: [d.source_interaction_id as string],
    });
    if (srcRs.rows.length > 0) {
      const sourceTs = (srcRs.rows[0] as Record<string, unknown>).ts;
      if (sourceTs != null) {
        const newerRs = await client.execute({
          sql: `SELECT lead_id, from_phone FROM lead_interactions
                WHERE tenant_id = ? AND direction = 'inbound'
                  AND coalesce(sent_at, created_at) > ?`,
          args: [p_tenant_id, sourceTs as string],
        });
        for (const row of newerRs.rows) {
          const r = row as Record<string, unknown>;
          // SQL NULL semantics: newer.lead_id=d.lead_id is only true when both non-null;
          // regexp_replace(NULL,...) is NULL so a null from_phone never matches
          const leadMatch = d.lead_id != null && r.lead_id === d.lead_id;
          const phoneMatch = r.from_phone != null && digitsOnly(String(r.from_phone)).slice(-10) === phone10;
          if (leadMatch || phoneMatch) return null;
        }
      }
    }
  }

  // daily-cap pre-check (re-verified atomically inside the write batch below)
  const capRs = await client.execute({
    sql: `SELECT count(*) AS n FROM scheduled_sends
          WHERE tenant_id = ? AND actor_user_id = ? AND channel = 'sms'
            AND status IN ('pending','sending','sent') AND created_at >= ?`,
    args: [p_tenant_id, a.user_id as string, dayStartUtc],
  });
  if (Number((capRs.rows[0] as Record<string, unknown>).n) >= Number(a.daily_cap)) return null;

  // Atomic write. libsql batch runs in ONE transaction; SQLite's single-writer model makes the
  // guarded INSERT..SELECT a compare-and-swap that replaces the PG FOR UPDATE locks: every
  // SQL-expressible guard (draft still pending, account still enabled+semi, approver authorized,
  // phone not suppressed, daily cap under limit) is re-evaluated at write time, and the UPDATE
  // only fires if the INSERT landed in this same transaction.
  const send_id = crypto.randomUUID();
  const batchRs = await client.batch(
    [
      {
        sql: `INSERT INTO scheduled_sends
                (id, tenant_id, lead_id, thread_key, channel, to_phone, body, actor_user_id,
                 from_identity, scheduled_for, status, created_at)
              SELECT ?, ?, d.lead_id, d.thread_key, 'sms', d.to_phone, ?, a.user_id,
                     a.from_number, ?, 'pending', ?
              FROM sunbiz_reply_drafts d
              JOIN sunbiz_agent_accounts a
                ON a.id = d.agent_account_id AND a.tenant_id = ? AND a.enabled = 1 AND a.mode = 'semi'
              WHERE d.id = ? AND d.tenant_id = ? AND d.status = 'pending'
                AND (a.user_id = ? OR EXISTS (
                      SELECT 1 FROM user_profiles up
                      WHERE up.tenant_id = ? AND up.auth_user_id = ?
                        AND (up.is_owner = 1 OR up.team_role IN ('owner','admin'))))
                AND NOT EXISTS (
                      SELECT 1 FROM sunbiz_phone_suppressions sp
                      WHERE sp.tenant_id = ? AND sp.phone_last10 = ?)
                AND (SELECT count(*) FROM scheduled_sends ss
                      WHERE ss.tenant_id = ? AND ss.actor_user_id = a.user_id AND ss.channel = 'sms'
                        AND ss.status IN ('pending','sending','sent')
                        AND ss.created_at >= ?) < a.daily_cap`,
        args: [
          send_id, p_tenant_id, finalText, nowIso, nowIso,
          p_tenant_id, p_draft_id, p_tenant_id,
          p_user_id, p_tenant_id, p_user_id,
          p_tenant_id, phone10,
          p_tenant_id, dayStartUtc,
        ],
      },
      {
        sql: `UPDATE sunbiz_reply_drafts
              SET status = 'approved', final_text = ?, approved_by = ?, approved_at = ?,
                  scheduled_send_id = ?, updated_at = ?
              WHERE id = ? AND tenant_id = ? AND status = 'pending'
                AND EXISTS (SELECT 1 FROM scheduled_sends WHERE id = ?)`,
        args: [finalText, p_user_id, nowIso, send_id, nowIso, p_draft_id, p_tenant_id, send_id],
      },
    ],
    "write",
  );

  if (batchRs[0].rowsAffected === 1 && batchRs[1].rowsAffected === 1) return send_id;
  return null; // CAS lost: concurrent approval / state change — nothing usable was written
}
/**
 * Port of public.close_website_deal — comp v2 shape
 * (database/147_website_sales_comp_v2.sql; tables in
 * database/turso/147_website_sales_engine.turso.sql).
 *
 * Rate keys on WHO CLOSED, not deal size: p_closed_by_rep=true means the
 * attributed rep ran the close themselves (30%); false means the founder
 * closed a rep-opened deal (20%). $2,000 collected-setup floor. Commission is
 * ALWAYS inserted 'accrued' — rep-closed deals never auto-approve; the
 * founder-gated accrued→approved→paid flow is untouched.
 *
 * The PG original's auth.role()='service_role' guard has no Turso equivalent:
 * this shim is only reachable through getServiceSupabase()'s rpc proxy, which
 * is the service surface by construction (same treatment as every other port).
 *
 * Atomicity note: money writes (deal + commission + onboarding) are one libsql
 * batch = one transaction. The stage patch runs AFTER, via the ported
 * patch_tenant_record_data. If the patch fails, re-issuing the identical close
 * is safe: the idempotent re-close path no-ops the money writes and re-applies
 * the patch.
 */
export async function close_website_deal(client: Client, args: Record<string, unknown>): Promise<unknown> {
  const p_tenant_id = typeof args.p_tenant_id === "string" ? args.p_tenant_id : null;
  const p_lead_id = typeof args.p_lead_id === "string" ? args.p_lead_id : null;
  const p_rep_user_id = typeof args.p_rep_user_id === "string" ? args.p_rep_user_id : null;
  const p_founder_user_id = typeof args.p_founder_user_id === "string" ? args.p_founder_user_id : null;
  const p_package_id = typeof args.p_package_id === "string" ? args.p_package_id : null;
  const p_currency = typeof args.p_currency === "string" ? args.p_currency : null;
  const p_payment_reference =
    typeof args.p_payment_reference === "string" && args.p_payment_reference.trim().length > 0
      ? args.p_payment_reference
      : null;
  // p_closed_by_rep boolean DEFAULT false — an omitted arg is the founder path,
  // exactly like the Postgres default. Anything not literally true is false.
  const p_closed_by_rep = args.p_closed_by_rep === true;

  // text[] arrives as a JS array from the route; a PostgREST-style JSON string
  // is tolerated. coalesce(p_automation_ids, '{}') -> [].
  let automationIds: string[] = [];
  if (Array.isArray(args.p_automation_ids)) {
    automationIds = args.p_automation_ids.map(String);
  } else if (typeof args.p_automation_ids === "string") {
    try {
      const parsed = JSON.parse(args.p_automation_ids);
      if (!Array.isArray(parsed)) throw new Error("not an array");
      automationIds = parsed.map(String);
    } catch {
      throw new Error(`malformed array literal: "${args.p_automation_ids}"`);
    }
  }

  const p_setup_amount = Number(args.p_setup_amount);
  const p_monthly_amount = Number(args.p_monthly_amount);
  if (!Number.isFinite(p_setup_amount) || !Number.isFinite(p_monthly_amount)) {
    throw new Error("invalid input syntax for type numeric");
  }

  // NULL required params can never satisfy the PG guards — fail closed, loudly.
  if (!p_tenant_id || !p_lead_id || !p_rep_user_id || !p_founder_user_id || !p_package_id || !p_currency || !p_payment_reference) {
    throw new Error("close_website_deal: missing required argument");
  }

  const nowIso = new Date().toISOString();

  // select data into v_lead_data from tenant_records where ... entity_type='lead'
  // A row whose data is NULL raises lead_not_found in the PG source too
  // (v_lead_data is null covers both no-row and null-data).
  const leadRs = await client.execute({
    sql: `SELECT data FROM tenant_records WHERE id = ? AND tenant_id = ? AND entity_type = 'lead'`,
    args: [p_lead_id, p_tenant_id],
  });
  const leadDataText = leadRs.rows.length > 0 ? ((leadRs.rows[0]["data"] ?? null) as string | null) : null;
  if (leadDataText === null) throw new Error("lead_not_found_or_wrong_tenant");
  let leadData: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(leadDataText);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      leadData = parsed as Record<string, unknown>;
    }
  } catch {
    throw new Error(`close_website_deal: tenant_records.data is not valid JSON for id=${p_lead_id}`);
  }

  // Closer guard, adapted per 147: the owner/admin check applies only on the
  // founder path. On the rep path the closer IS the rep, and authorization
  // comes from the rep guards below (team_role='agent' + frozen attribution).
  if (!p_closed_by_rep) {
    const founderRs = await client.execute({
      sql: `SELECT 1 FROM user_profiles
            WHERE tenant_id = ? AND auth_user_id = ?
              AND (is_owner = 1 OR team_role IN ('owner','admin'))
            LIMIT 1`,
      args: [p_tenant_id, p_founder_user_id],
    });
    if (founderRs.rows.length === 0) throw new Error("founder_not_authorized_for_tenant");
  }

  const repRs = await client.execute({
    sql: `SELECT 1 FROM user_profiles WHERE tenant_id = ? AND auth_user_id = ? AND team_role = 'agent' LIMIT 1`,
    args: [p_tenant_id, p_rep_user_id],
  });
  if (repRs.rows.length === 0) throw new Error("rep_not_agent_for_tenant");

  // v_frozen_rep := coalesce(data->>'attributed_rep_user_id', data->>'assigned_to')
  const frozenRaw = leadData.attributed_rep_user_id ?? leadData.assigned_to ?? null;
  const frozenRep = typeof frozenRaw === "string" && frozenRaw.length > 0 ? frozenRaw : null;
  if (frozenRep === null || frozenRep !== p_rep_user_id) {
    throw new Error("rep_does_not_match_frozen_attribution");
  }

  if (p_setup_amount < 2000) throw new Error("collected setup below commission floor");

  const v_closed_by = p_closed_by_rep ? p_rep_user_id : p_founder_user_id;
  const v_rate = v_closed_by === p_rep_user_id ? 0.3 : 0.2;
  // round(numeric, 2) — half-up on positive amounts, same as Math.round here.
  const v_amount = Math.round(p_setup_amount * v_rate * 100) / 100;
  const automationText = JSON.stringify(automationIds);

  // select * into v_deal ... for update — SQLite's single-writer model plus the
  // write batch below replaces the row lock. A concurrent first-close race is
  // caught by UNIQUE(tenant_id, lead_id) failing the batch, never by silence.
  const dealRs = await client.execute({
    sql: `SELECT id, status, rep_user_id, founder_user_id, package_id, automation_ids,
                 currency, setup_amount, monthly_amount, payment_reference, closed_by
          FROM website_deals WHERE tenant_id = ? AND lead_id = ?`,
    args: [p_tenant_id, p_lead_id],
  });

  let dealId: string;
  let dealIsNew = false;
  if (dealRs.rows.length > 0) {
    // Idempotent re-close: an identical replay returns the existing deal; any
    // drift — including a different closer, which would change the rate — is a
    // hard 'deal_already_closed_mismatch', mirroring the PG OR-chain.
    const d = dealRs.rows[0] as Record<string, unknown>;
    const mismatch =
      d.status !== "won" ||
      d.rep_user_id !== p_rep_user_id ||
      d.founder_user_id !== p_founder_user_id ||
      d.package_id !== p_package_id ||
      String(d.automation_ids ?? "[]") !== automationText ||
      d.currency !== p_currency ||
      Number(d.setup_amount) !== p_setup_amount ||
      Number(d.monthly_amount) !== p_monthly_amount ||
      d.payment_reference !== p_payment_reference ||
      ((d.closed_by ?? null) as string | null) !== v_closed_by;
    if (mismatch) throw new Error("deal_already_closed_mismatch");
    dealId = String(d.id);
  } else {
    dealId = crypto.randomUUID();
    dealIsNew = true;
  }

  const writes: Array<{ sql: string; args: Array<string | number | null> }> = [];
  if (dealIsNew) {
    writes.push({
      sql: `INSERT INTO website_deals
              (id, tenant_id, lead_id, rep_user_id, founder_user_id, closed_by, package_id,
               automation_ids, currency, setup_amount, monthly_amount, proposal_status,
               status, payment_reference, closed_at, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'accepted', 'won', ?, ?, ?, ?)`,
      args: [
        dealId, p_tenant_id, p_lead_id, p_rep_user_id, p_founder_user_id, v_closed_by,
        p_package_id, automationText, p_currency, p_setup_amount, p_monthly_amount,
        p_payment_reference, nowIso, nowIso, nowIso,
      ],
    });
  }
  // The 146/147 upsert trick, verbatim in SQLite: DO UPDATE is a self-assign
  // no-op gated on deal_id = excluded.deal_id. Fresh insert and same-deal
  // replay both RETURN the row; a payment_reference already owned by ANOTHER
  // deal fails the WHERE, returns nothing, and we raise after the batch.
  writes.push({
    sql: `INSERT INTO website_sales_commissions
            (id, tenant_id, deal_id, rep_user_id, payment_reference, entry_type,
             collected_setup_amount, rate, amount, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, 'accrual', ?, ?, ?, 'accrued', ?, ?)
          ON CONFLICT ("tenant_id", "payment_reference", "entry_type")
          DO UPDATE SET "updated_at" = "updated_at" WHERE "deal_id" = excluded."deal_id"
          RETURNING id, amount`,
    args: [
      crypto.randomUUID(), p_tenant_id, dealId, p_rep_user_id, p_payment_reference,
      p_setup_amount, v_rate, v_amount, nowIso, nowIso,
    ],
  });
  writes.push({
    sql: `INSERT INTO website_onboarding (id, tenant_id, deal_id, lead_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT ("tenant_id", "deal_id") DO NOTHING`,
    args: [crypto.randomUUID(), p_tenant_id, dealId, p_lead_id, nowIso, nowIso],
  });

  const batchRs = await client.batch(writes, "write");
  const commissionRs = batchRs[dealIsNew ? 1 : 0];
  const cRow = commissionRs.rows[0] as Record<string, unknown> | undefined;
  if (!cRow) throw new Error("payment_reference_already_used_by_another_deal");

  // perform patch_tenant_record_data(... 'stage','onboarding' ...) — through
  // the ported CAS implementation later in this file (hoisted declaration).
  await patch_tenant_record_data(client, {
    p_id: p_lead_id,
    p_tenant_id,
    p_patch: {
      stage: "onboarding",
      stage_entered_at: nowIso,
      closed_by: v_closed_by,
      collected_setup_amount: p_setup_amount,
      quoted_monthly_amount: p_monthly_amount,
    },
  });

  // RETURNS jsonb — supabase-js callers receive this object as { data }.
  return {
    deal_id: dealId,
    commission_id: String(cRow.id),
    commission_amount: Number(cRow.amount),
  };
}
export async function consume_texttorrent_rate_token(client: Client, args: Record<string, unknown>): Promise<unknown> {
  // Signature parity: p_bucket text, p_worker_id text (unused in SQL body), p_priority int,
  // p_limit int DEFAULT 60, p_window_seconds int DEFAULT 60. Returns boolean.
  const p_bucket = args.p_bucket;
  const p_priority = args.p_priority;
  const p_limit = args.p_limit === undefined || args.p_limit === null ? 60 : Number(args.p_limit);
  const p_window_seconds =
    args.p_window_seconds === undefined || args.p_window_seconds === null ? 60 : Number(args.p_window_seconds);

  // if p_bucket !~ '^[0-9a-fA-F-]{36}:parent-sid$' then return false
  // Bucket format is <tenant_uuid>:parent-sid — every worker sharing the parent
  // credential must consume this same tenant bucket.
  if (typeof p_bucket !== "string" || !/^[0-9a-fA-F-]{36}:parent-sid$/.test(p_bucket)) {
    return false;
  }

  // tid := split_part(p_bucket, ':', 1)::uuid — the cast RAISES in Postgres on a
  // 36-char hex/hyphen string that is not a valid uuid; mirror that as a throw.
  const rawTid = p_bucket.split(":")[0];
  if (!/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(rawTid)) {
    throw new Error(`invalid input syntax for type uuid: "${rawTid}"`);
  }
  const tid = rawTid.toLowerCase(); // Postgres uuid canonicalizes to lowercase

  // effective_limit := greatest(1, least(p_limit, CASE priority tiers END))
  // 90+ (compliance) uses all tokens; 80+ (approved replies) retains 5;
  // 50+ (normal inbound) retains 10; low-priority analytics/backfills retain 20.
  const pri = typeof p_priority === "number" ? p_priority : Number(p_priority);
  let tiered: number;
  if (pri >= 90) tiered = p_limit;
  else if (pri >= 80) tiered = p_limit - 5;
  else if (pri >= 50) tiered = p_limit - 10;
  else tiered = p_limit - 20; // NULL/NaN priority falls through to ELSE, same as SQL CASE
  const effectiveLimit = Math.max(1, Math.min(p_limit, tiered));

  // now() is the transaction timestamp in Postgres — capture once and reuse.
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const cutoffIso = new Date(nowMs - p_window_seconds * 1000).toISOString();

  // Single-statement upsert = atomic in SQLite exactly like the Postgres
  // INSERT ... ON CONFLICT. The DO UPDATE ... WHERE gate leaves rowsAffected=0
  // when the window is current AND the count is at/over the effective limit —
  // that 0 is the "no token" signal (GET DIAGNOSTICS row_count in the source).
  // Unqualified column refs in DO UPDATE resolve to the existing row (pre-update),
  // matching the sunbiz_provider_rate_state.<col> refs in the Postgres version.
  // ISO-8601 TEXT timestamps (millisecond precision, Z suffix) compare correctly
  // as strings against the schema's strftime('%Y-%m-%dT%H:%M:%fZ','now') format.
  const res = await client.execute({
    sql: `
      INSERT INTO sunbiz_provider_rate_state
        (bucket, tenant_id, provider, window_started_at, request_count, updated_at)
      VALUES (:bucket, :tid, 'texttorrent', :now, 1, :now)
      ON CONFLICT(bucket) DO UPDATE SET
        window_started_at = CASE WHEN window_started_at < :cutoff THEN :now ELSE window_started_at END,
        request_count     = CASE WHEN window_started_at < :cutoff THEN 1 ELSE request_count + 1 END,
        updated_at        = :now
      WHERE window_started_at < :cutoff
         OR request_count < :effective_limit
    `,
    args: {
      bucket: p_bucket,
      tid,
      now: nowIso,
      cutoff: cutoffIso,
      effective_limit: effectiveLimit,
    },
  });

  // get diagnostics changed = row_count; return changed > 0
  return res.rowsAffected > 0;
}
export async function find_similar_merchants(
  client: Client,
  args: Record<string, unknown>
): Promise<unknown> {
  // Port of public.find_similar_merchants(p_tenant_id uuid, p_business_name text,
  //   p_state text DEFAULT NULL, p_threshold real DEFAULT 0.4, p_limit integer DEFAULT 10)
  //   RETURNS TABLE(record_id, entity_type, business_name, state, similarity, ein, email, phone)
  // STABLE / read-only.
  //
  // AUTH NOTE: the PL/pgSQL guards only callers whose PostgREST JWT role is
  // 'authenticated' (via current_setting('request.jwt.claim.role')). Its own
  // comment defines a NULL role — a direct server-side connection, which is
  // exactly what this libsql shim is — as the trusted service_role path that
  // falls through unguarded. So the membership check against user_profiles is
  // unreachable here and is intentionally not performed.

  // ---- argument unpacking (missing optional args take the SQL defaults) ----
  const rawTenant = args.p_tenant_id === undefined ? null : args.p_tenant_id;
  const rawName = args.p_business_name === undefined ? null : args.p_business_name;
  const rawState = args.p_state === undefined ? null : args.p_state;
  const rawThreshold = args.p_threshold === undefined ? 0.4 : args.p_threshold;
  const rawLimit = args.p_limit === undefined ? 10 : args.p_limit;

  // uuid cast for p_tenant_id (in Postgres this happens at the call boundary).
  // Postgres normalizes uuids to lowercase-hyphenated, so equality is
  // case-insensitive there; Turso stores TEXT, so normalize before comparing.
  let tenantId: string | null = null;
  if (rawTenant !== null) {
    const s = String(rawTenant).trim().replace(/^\{/, "").replace(/\}$/, "");
    const hex = s.replace(/-/g, "");
    if (!/^[0-9a-fA-F]{32}$/.test(hex)) {
      throw new Error(`invalid input syntax for type uuid: "${String(rawTenant)}"`);
    }
    const h = hex.toLowerCase();
    tenantId = `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }

  // LIMIT semantics: negative raises in Postgres; LIMIT NULL means no limit.
  if (rawLimit !== null && Number(rawLimit) < 0) {
    throw new Error("LIMIT must not be negative");
  }
  const limit = rawLimit === null ? Infinity : Math.trunc(Number(rawLimit));

  // similarity() is STRICT: NULL p_business_name -> NULL sim -> WHERE is not
  // true -> empty set. Same for NULL p_threshold (sim >= NULL) and NULL
  // p_tenant_id (tenant_id = NULL matches nothing).
  if (tenantId === null || rawName === null || rawThreshold === null) return [];

  const pName = String(rawName);
  const threshold = Math.fround(Number(rawThreshold)); // real (float4)
  const pState = rawState === null ? null : String(rawState);

  // ---- pg_trgm similarity(), default build flags (IGNORECASE + KEEPONLYALNUM) ----
  // Words are maximal runs of alphanumerics; each word is padded '  w ' and
  // split into 3-grams; the string's trigram set is deduplicated.
  const trigramsOf = (str: string): Set<string> => {
    const grams = new Set<string>();
    for (const word of str.split(/[^\p{L}\p{N}]+/u)) {
      if (word.length === 0) continue;
      const chars = Array.from("  " + word + " "); // code points, like PG chars
      for (let i = 0; i + 3 <= chars.length; i++) {
        grams.add(chars[i] + chars[i + 1] + chars[i + 2]);
      }
    }
    return grams;
  };
  // sml = shared / (len1 + len2 - shared); explicit 0 when either set is
  // empty (pg_trgm cnt_sml guard). Math.fround reproduces float4 division.
  const pgSimilarity = (a: Set<string>, b: Set<string>): number => {
    if (a.size === 0 || b.size === 0) return 0;
    let shared = 0;
    for (const g of a) if (b.has(g)) shared++;
    return Math.fround(shared / (a.size + b.size - shared));
  };

  // Postgres jsonb ->> 'key' semantics: text for strings, decimal text for
  // numbers, 'true'/'false' for booleans, NULL for json null / missing key /
  // non-object container, JSON text for nested objects/arrays.
  const jsonText = (obj: unknown, key: string): string | null => {
    if (obj === null || typeof obj !== "object" || Array.isArray(obj)) return null;
    const v = (obj as Record<string, unknown>)[key];
    if (v === undefined || v === null) return null;
    if (typeof v === "string") return v;
    if (typeof v === "boolean") return v ? "true" : "false";
    if (typeof v === "number") return String(v);
    return JSON.stringify(v);
  };

  // ---- candidates CTE: tenant-scoped, entity_type-filtered ----
  const rs = await client.execute({
    sql: `SELECT id, entity_type, data
          FROM tenant_records
          WHERE tenant_id = ?
            AND entity_type IN ('lead', 'application', 'funded_deal')`,
    args: [tenantId],
  });

  const nameTrgm = trigramsOf(pName.toLowerCase());
  const stateLower = pState === null ? null : pState.toLowerCase();

  const matches: Array<{
    record_id: string;
    entity_type: string;
    business_name: string;
    state: string | null;
    similarity: number;
    ein: string | null;
    email: string | null;
    phone: string | null;
    _len: number;
  }> = [];

  for (const row of rs.rows) {
    const r = row as unknown as Record<string, unknown>;
    let data: unknown = null;
    try {
      data = JSON.parse(String(r.data ?? "null"));
    } catch {
      // Cannot happen under PG jsonb; a corrupt TEXT row yields no keys and
      // is excluded by the biz IS NOT NULL predicate below.
      data = null;
    }

    const biz =
      jsonText(data, "legal_name") ??
      jsonText(data, "business_name") ??
      jsonText(data, "name");
    if (biz === null) continue; // coalesce(...) IS NOT NULL

    const sim = pgSimilarity(trigramsOf(biz.toLowerCase()), nameTrgm);
    if (!(sim >= threshold)) continue; // similarity(...) >= p_threshold

    const st = jsonText(data, "state") ?? jsonText(data, "physical_state");
    // (p_state IS NULL OR lower(c.st) = lower(p_state)) — NULL st never matches
    if (stateLower !== null && (st === null || st.toLowerCase() !== stateLower)) {
      continue;
    }

    matches.push({
      record_id: String(r.id),
      entity_type: String(r.entity_type),
      business_name: biz,
      state: st,
      similarity: sim,
      ein: jsonText(data, "ein"),
      email: jsonText(data, "email"),
      phone: jsonText(data, "phone"),
      _len: Array.from(biz).length, // length() counts characters, not bytes
    });
  }

  // ORDER BY sim DESC, length(c.biz) ASC; LIMIT p_limit
  matches.sort((a, b) =>
    b.similarity !== a.similarity ? b.similarity - a.similarity : a._len - b._len
  );

  return matches
    .slice(0, limit === Infinity ? matches.length : limit)
    .map(({ _len, ...out }) => out);
}
export async function force_materialize_today_plan(
  client: Client,
  args: Record<string, unknown>,
): Promise<unknown> {
  // p_profile_id uuid (required — no default in the Postgres signature)
  const p_profile_id = args["p_profile_id"];
  if (typeof p_profile_id !== "string" || p_profile_id.length === 0) {
    throw new Error("force_materialize_today_plan: p_profile_id is required");
  }

  // v_target_date := COALESCE(p_target_date, current_date)
  const rawDate = args["p_target_date"];
  let targetDate: string;
  if (rawDate === null || rawDate === undefined) {
    targetDate = new Date().toISOString().slice(0, 10); // UTC "today", YYYY-MM-DD
  } else if (typeof rawDate === "string") {
    const m = rawDate.match(/^(\d{4}-\d{2}-\d{2})/);
    if (!m) {
      throw new Error(`invalid input syntax for type date: "${rawDate}"`);
    }
    targetDate = m[1];
  } else {
    throw new Error(`invalid input syntax for type date: "${String(rawDate)}"`);
  }

  // v_dow := EXTRACT(DOW FROM v_target_date)  -- 0 = Sunday .. 6 = Saturday
  const dow = new Date(`${targetDate}T00:00:00Z`).getUTCDay();
  const kind = dow === 0 || dow === 6 ? "weekend" : "weekday";

  // SELECT tenant_id INTO v_tenant_id FROM user_profiles WHERE id = p_profile_id
  const tenantRs = await client.execute({
    sql: "SELECT tenant_id FROM user_profiles WHERE id = ? LIMIT 1",
    args: [p_profile_id],
  });
  const tenantId =
    tenantRs.rows.length > 0 ? (tenantRs.rows[0]["tenant_id"] as string | null) : null;
  if (tenantId === null || tenantId === undefined) {
    // Matches RAISE EXCEPTION (ERRCODE 22023); also fires when the profile row
    // is missing entirely — PL/pgSQL SELECT INTO leaves the variable NULL.
    throw new Error("profile has no tenant_id");
  }

  // SELECT * INTO v_template FROM plan_templates
  //  WHERE profile_id = ? AND kind = ? AND enabled = true LIMIT 1
  // (enabled is INTEGER 0/1 in SQLite; scoped by profile_id only, as in the source)
  const tmplRs = await client.execute({
    sql:
      "SELECT mission, target_calls, target_emails, target_bookings, schedule " +
      "FROM plan_templates WHERE profile_id = ? AND kind = ? AND enabled = 1 LIMIT 1",
    args: [p_profile_id, kind],
  });
  const tmpl = tmplRs.rows.length > 0 ? tmplRs.rows[0] : null;

  const mission = (tmpl?.["mission"] as string | null) ?? "Daily ops";
  const targetCalls = (tmpl?.["target_calls"] as number | null) ?? 0;
  const targetEmails = (tmpl?.["target_emails"] as number | null) ?? 0;
  const targetBookings = (tmpl?.["target_bookings"] as number | null) ?? 1;
  const schedule = (tmpl?.["schedule"] as string | null) ?? "[]"; // jsonb -> TEXT passthrough

  const nowIso = new Date().toISOString();
  const newId = crypto.randomUUID();

  // Single-statement upsert — atomic in libsql. Relies on the unique index
  // daily_plans_profile_id_plan_date_key (profile_id, plan_date), transpiled 1:1
  // from the Postgres constraint the ON CONFLICT targets. On conflict the
  // existing row keeps its id/created_at/tenant_id, exactly like Postgres.
  const upsertRs = await client.execute({
    sql:
      "INSERT INTO daily_plans (" +
      "  id, tenant_id, profile_id, plan_date, mission," +
      "  target_calls, target_emails, target_bookings, schedule," +
      "  created_at, updated_at" +
      ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
      "ON CONFLICT (profile_id, plan_date) DO UPDATE SET " +
      "  schedule        = excluded.schedule," +
      "  mission         = excluded.mission," +
      "  target_calls    = excluded.target_calls," +
      "  target_emails   = excluded.target_emails," +
      "  target_bookings = excluded.target_bookings," +
      "  finalized_at    = NULL," +
      "  updated_at      = excluded.updated_at " +
      "RETURNING id",
    args: [
      newId,
      tenantId,
      p_profile_id,
      targetDate,
      mission,
      targetCalls,
      targetEmails,
      targetBookings,
      schedule,
      nowIso,
      nowIso,
    ],
  });
  if (upsertRs.rows.length === 0) {
    throw new Error("force_materialize_today_plan: upsert returned no row");
  }

  // RETURNS uuid — scalar; supabase-js callers receive it as { data }
  return upsertRs.rows[0]["id"];
}
/**
 * Port of Postgres RPC public.log_tenant_event(
 *   p_tenant_id uuid, p_action_type text, p_target_table text DEFAULT NULL,
 *   p_target_id text DEFAULT NULL, p_before jsonb DEFAULT NULL, p_after jsonb DEFAULT NULL,
 *   p_ip_hash text DEFAULT NULL, p_user_agent text DEFAULT NULL, p_metadata jsonb DEFAULT '{}'
 * ) RETURNS uuid — source: database/rpc_sources/bravo__log_tenant_event.sql
 *
 * Auth mapping: a libsql connection carries no Supabase Auth context — it IS the
 * service credential, i.e. the exact equivalent of auth.role() = 'service_role'.
 * The original skips its tenant-membership gate on that path and auth.uid() is
 * NULL, so actor_user_id / actor_email are stored as NULL — identical to a
 * service-role invocation against Postgres. The user-JWT branch ('authenticated
 * user required' / 'cannot log audit events for another tenant') is unreachable
 * over libsql; enforce caller-tenant membership in the app layer if a call site
 * previously relied on it with a user JWT.
 */
export async function log_tenant_event(
  client: Client,
  args: Record<string, unknown>,
): Promise<unknown> {
  const known = new Set([
    "p_tenant_id", "p_action_type", "p_target_table", "p_target_id",
    "p_before", "p_after", "p_ip_hash", "p_user_agent", "p_metadata",
  ]);
  for (const key of Object.keys(args)) {
    if (!known.has(key)) {
      // PostgREST resolves RPCs by their named-arg set; an unrecognized arg
      // means no matching function. Fail closed rather than silently drop it.
      throw new Error(
        `Could not find the function public.log_tenant_event(${Object.keys(args).sort().join(", ")}) in the schema cache`,
      );
    }
  }

  const text = (v: unknown): string | null => (v == null ? null : String(v));
  // PostgREST casts the JSON value of a jsonb arg verbatim: objects/arrays/strings/
  // numbers all serialize exactly as JSON.stringify produces them.
  const jsonb = (v: unknown): string | null => (v == null ? null : JSON.stringify(v));

  // IF p_tenant_id IS NULL THEN RAISE EXCEPTION 'tenant_id required';
  const tenantId = text(args.p_tenant_id);
  if (tenantId === null) {
    throw new Error("tenant_id required");
  }
  // Postgres rejected non-uuid input at the uuid cast (SQLSTATE 22P02); SQLite's
  // TEXT column would silently accept it, so validate here.
  const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
  if (!UUID_RE.test(tenantId)) {
    throw new Error(`invalid input syntax for type uuid: "${tenantId}"`);
  }

  const id = crypto.randomUUID(); // replaces the column's uuid DEFAULT so we can return it
  const nowIso = new Date().toISOString(); // replaces now(); ISO-8601 TEXT

  // Single-statement INSERT — atomic in SQLite exactly as it was in Postgres.
  // action_type is NOT NULL in the schema: a null raises here, as it did in Postgres.
  await client.execute({
    sql: `INSERT INTO "tenant_audit_log" (
            "id", "tenant_id", "actor_user_id", "actor_email",
            "action_type", "target_table", "target_id",
            "before", "after", "ip_hash", "user_agent", "metadata", "created_at"
          ) VALUES (?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      id,
      tenantId,
      text(args.p_action_type),
      text(args.p_target_table),
      text(args.p_target_id),
      jsonb(args.p_before),
      jsonb(args.p_after),
      text(args.p_ip_hash),
      text(args.p_user_agent),
      // COALESCE(p_metadata, '{}'::jsonb) — also covers the omitted-arg DEFAULT
      args.p_metadata == null ? "{}" : JSON.stringify(args.p_metadata),
      nowIso,
    ],
  });

  // RETURNS uuid — scalar; supabase-js callers receive it as { data: "<uuid>" }.
  return id;
}
export async function materialize_today_plan(
  client: Client,
  args: Record<string, unknown>,
): Promise<unknown> {
  const p_profile_id = args.p_profile_id;
  if (typeof p_profile_id !== 'string' || p_profile_id.length === 0) {
    throw new Error('materialize_today_plan: p_profile_id is required');
  }

  // v_target_date := COALESCE(p_target_date, current_date)
  const rawDate = args.p_target_date;
  let v_target_date: string;
  if (rawDate === undefined || rawDate === null) {
    v_target_date = new Date().toISOString().slice(0, 10); // UTC calendar date
  } else {
    const s =
      rawDate instanceof Date ? rawDate.toISOString().slice(0, 10) : String(rawDate);
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
    if (!m) {
      throw new Error(`invalid input syntax for type date: "${s}"`);
    }
    v_target_date = `${m[1]}-${m[2]}-${m[3]}`;
    const dt = new Date(`${v_target_date}T00:00:00Z`);
    if (Number.isNaN(dt.getTime()) || dt.toISOString().slice(0, 10) !== v_target_date) {
      throw new Error(`date/time field value out of range: "${s}"`);
    }
  }

  // v_dow := EXTRACT(DOW FROM v_target_date) — 0=Sunday .. 6=Saturday
  const v_dow = new Date(`${v_target_date}T00:00:00Z`).getUTCDay();
  const v_kind = v_dow === 0 || v_dow === 6 ? 'weekend' : 'weekday';

  // SELECT tenant_id INTO v_tenant_id FROM user_profiles WHERE id = p_profile_id
  const profileRes = await client.execute({
    sql: 'SELECT tenant_id FROM user_profiles WHERE id = ? LIMIT 1',
    args: [p_profile_id],
  });
  const v_tenant_id = (profileRes.rows[0]?.tenant_id ?? null) as string | null;
  if (v_tenant_id === null) {
    // PL/pgSQL: RAISE EXCEPTION 'profile has no tenant_id' (ERRCODE 22023).
    // Fires both when the profile row is missing and when tenant_id is NULL,
    // exactly like SELECT INTO leaving the variable NULL.
    throw new Error('profile has no tenant_id');
  }

  // SELECT * INTO v_template FROM plan_templates
  // WHERE profile_id = ? AND kind = ? AND enabled = true LIMIT 1
  // (enabled is INTEGER 0/1 in SQLite storage)
  const tmplRes = await client.execute({
    sql: `SELECT mission, target_calls, target_emails, target_bookings, schedule
          FROM plan_templates
          WHERE profile_id = ? AND kind = ? AND enabled = 1
          LIMIT 1`,
    args: [p_profile_id, v_kind],
  });
  const tmpl = tmplRes.rows[0];

  // Per-column COALESCE mirrors the PL/pgSQL: covers both "no template row"
  // (record is all-NULL) and "row exists but mission is NULL".
  const mission = (tmpl?.mission ?? 'Daily ops') as string;
  const target_calls = Number(tmpl?.target_calls ?? 0);
  const target_emails = Number(tmpl?.target_emails ?? 0);
  const target_bookings = Number(tmpl?.target_bookings ?? 1);
  const schedule = (tmpl?.schedule ?? '[]') as string; // jsonb -> TEXT in Turso

  // Atomic insert-or-no-op. ON CONFLICT DO NOTHING + RETURNING yields no row
  // when the unique index daily_plans_profile_id_plan_date_key blocks the
  // insert. Single statement => atomic in libsql, same as the Postgres
  // original; no caller ever sees a duplicate-key error.
  const now = new Date().toISOString();
  const insertRes = await client.execute({
    sql: `INSERT INTO daily_plans (
            id, tenant_id, profile_id, plan_date, mission,
            target_calls, target_emails, target_bookings, schedule,
            created_at, updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (profile_id, plan_date) DO NOTHING
          RETURNING id`,
    args: [
      crypto.randomUUID(),
      v_tenant_id,
      p_profile_id,
      v_target_date,
      mission,
      target_calls,
      target_emails,
      target_bookings,
      schedule,
      now,
      now,
    ],
  });

  let v_plan_id = (insertRes.rows[0]?.id ?? null) as string | null;

  // IF v_plan_id IS NULL THEN fetch the existing plan's id. Safe outside a
  // transaction: reaching this branch proves the row already exists.
  if (v_plan_id === null) {
    const existing = await client.execute({
      sql: 'SELECT id FROM daily_plans WHERE profile_id = ? AND plan_date = ? LIMIT 1',
      args: [p_profile_id, v_target_date],
    });
    v_plan_id = (existing.rows[0]?.id ?? null) as string | null;
  }

  // RETURNS uuid — scalar; supabase-js callers receive this as { data }
  return v_plan_id;
}
export async function patch_tenant_record_data(
  client: Client,
  args: Record<string, unknown>
): Promise<unknown> {
  const p_id = (args.p_id ?? null) as string | null;
  const p_tenant_id = (args.p_tenant_id ?? null) as string | null;
  let rawPatch: unknown = args.p_patch;

  // PostgREST parses a JSON-string body value before it reaches the jsonb param.
  if (typeof rawPatch === "string") {
    try {
      rawPatch = JSON.parse(rawPatch);
    } catch {
      throw new Error("p_patch must be a non-null jsonb object");
    }
  }

  // RAISE EXCEPTION 'p_patch must be a non-null jsonb object' (ERRCODE 22023)
  if (
    rawPatch === null ||
    rawPatch === undefined ||
    typeof rawPatch !== "object" ||
    Array.isArray(rawPatch)
  ) {
    throw new Error("p_patch must be a non-null jsonb object");
  }
  const patch = rawPatch as Record<string, unknown>;

  // Postgres does this in ONE atomic statement:
  //   UPDATE tenant_records SET data = COALESCE(data,'{}') || p_patch, updated_at = now()
  //   WHERE id = p_id AND tenant_id = p_tenant_id RETURNING data
  // SQLite has no shallow-merge jsonb operator (json_patch() is a DEEP merge that
  // also strips null-valued keys — NOT equivalent to ||), so we do an optimistic
  // compare-and-swap: read the current data text, merge in JS, and only write if
  // the row still holds the exact text we read.
  const MAX_ATTEMPTS = 5;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const sel = await client.execute({
      sql: "SELECT data FROM tenant_records WHERE id = ? AND tenant_id = ?",
      args: [p_id, p_tenant_id],
    });

    if (sel.rows.length === 0) {
      // RAISE EXCEPTION 'lead_not_found_or_wrong_tenant: id=%, tenant=%' (ERRCODE 02000)
      throw new Error(
        `lead_not_found_or_wrong_tenant: id=${p_id ?? "<NULL>"}, tenant=${p_tenant_id ?? "<NULL>"}`
      );
    }

    const oldText = (sel.rows[0]["data"] ?? null) as string | null;

    // COALESCE(data, '{}'::jsonb)
    let oldObj: Record<string, unknown> = {};
    if (oldText !== null) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(oldText);
      } catch {
        throw new Error(
          `patch_tenant_record_data: tenant_records.data is not valid JSON for id=${p_id}`
        );
      }
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        oldObj = parsed as Record<string, unknown>;
      }
    }

    // jsonb || object-merge: shallow, top-level keys of p_patch win, explicit
    // JSON nulls in the patch are KEPT (json_patch would delete them — wrong).
    const merged: Record<string, unknown> = { ...oldObj, ...patch };
    const newText = JSON.stringify(merged);
    const nowIso = new Date().toISOString();

    // Single conditional UPDATE = the compare-and-swap. `IS` is SQLite's
    // null-safe equality, so a NULL oldText still matches correctly.
    const upd = await client.execute({
      sql:
        "UPDATE tenant_records SET data = ?, updated_at = ? " +
        "WHERE id = ? AND tenant_id = ? AND data IS ?",
      args: [newText, nowIso, p_id, p_tenant_id, oldText],
    });

    if (upd.rowsAffected === 1) {
      // RETURNS jsonb — supabase-js callers receive this object as { data }.
      return merged;
    }
    // Row changed (or vanished) between read and write — retry the CAS.
  }

  throw new Error(
    `patch_tenant_record_data: concurrent modification, gave up after ${MAX_ATTEMPTS} attempts (id=${p_id}, tenant=${p_tenant_id})`
  );
}
export async function preview_tenant_invite(
  client: Client,
  args: Record<string, unknown>
): Promise<unknown> {
  // PostgREST would reject a call missing the named argument — fail closed.
  if (!("p_token_hash" in args)) {
    throw new Error("preview_tenant_invite: missing required argument p_token_hash");
  }
  const p_token_hash = args.p_token_hash as string | null;

  // now() -> ISO-8601 UTC TEXT; lexicographic > is valid for ISO-8601 UTC strings.
  const nowIso = new Date().toISOString();

  // Original: SELECT * FROM tenant_invites WHERE token_hash = $1
  //             AND redeemed_at IS NULL AND revoked_at IS NULL AND expires_at > now() LIMIT 1;
  // then:     SELECT name FROM tenants WHERE id = v_invite.tenant_id;
  // Merged into one LEFT JOIN so the read is a single snapshot (function was STABLE).
  const rs = await client.execute({
    sql: `SELECT ti.tenant_id  AS tenant_id,
                 ti.team_role  AS team_role,
                 ti.expires_at AS expires_at,
                 ti.email      AS email,
                 t.name        AS tenant_name
          FROM tenant_invites ti
          LEFT JOIN tenants t ON t.id = ti.tenant_id
          WHERE ti.token_hash = ?
            AND ti.redeemed_at IS NULL
            AND ti.revoked_at IS NULL
            AND ti.expires_at > ?
          LIMIT 1`,
    args: [p_token_hash, nowIso],
  });

  // IF NOT FOUND THEN RETURN NULL
  if (rs.rows.length === 0) {
    return null;
  }

  const row = rs.rows[0];

  // jsonb_build_object(...) — supabase-js callers receive this object as { data }.
  return {
    tenant_id: row.tenant_id,
    tenant_name: (row.tenant_name ?? "a workspace") as string, // COALESCE(v_tenant_name, 'a workspace')
    team_role: row.team_role,
    expires_at: row.expires_at, // ISO-8601 TEXT, returned verbatim
    email_pinned: row.email ?? null,
  };
}
export async function record_inbound_from_n8n_v2(
  client: Client,
  args: Record<string, unknown>
): Promise<unknown> {
  // -- Named args (PostgREST style); undefined -> SQL NULL ------------------
  const profileId = (args.p_profile_id ?? null) as string | null;
  const secretHash = (args.p_secret_hash ?? null) as string | null;
  const fromEmail = (args.p_from_email ?? null) as string | null;
  const subject = (args.p_subject ?? null) as string | null;
  const body = (args.p_body ?? null) as string | null;
  const classification = args.p_classification === undefined ? null : args.p_classification;

  // Postgres: every now() inside the function returns the same transaction
  // timestamp — compute once, reuse everywhere. Stored as ISO-8601 TEXT.
  const nowIso = new Date().toISOString();

  // p_received_at timestamptz DEFAULT now():
  //   omitted        -> now()
  //   explicit null  -> NULL (explicit NULL overrides the column default, as in Postgres)
  //   value          -> parsed + normalized to UTC ISO-8601 (Postgres normalizes timestamptz)
  let receivedAt: string | null;
  if (args.p_received_at === undefined) {
    receivedAt = nowIso;
  } else if (args.p_received_at === null) {
    receivedAt = null;
  } else {
    const d = new Date(String(args.p_received_at));
    if (Number.isNaN(d.getTime())) {
      throw new Error(
        `invalid input syntax for type timestamp with time zone: "${String(args.p_received_at)}"`
      );
    }
    receivedAt = d.toISOString();
  }

  // -- Auth: validate secret hash (RAISE 'invalid_n8n_secret' / 42501) ------
  const secretRes = await client.execute({
    sql: `SELECT 1
            FROM n8n_webhook_secrets
           WHERE profile_id = ?
             AND secret_hash = ?
             AND revoked_at IS NULL
           LIMIT 1`,
    args: [profileId, secretHash],
  });
  if (secretRes.rows.length === 0) {
    throw new Error("invalid_n8n_secret");
  }

  // -- Resolve tenant from profile (inlines public.resolve_tenant_for_profile:
  //    SELECT tenant_id FROM user_profiles WHERE id = $1 LIMIT 1) -----------
  const tenantRes = await client.execute({
    sql: `SELECT tenant_id FROM user_profiles WHERE id = ? LIMIT 1`,
    args: [profileId],
  });
  const tenantId =
    tenantRes.rows.length > 0 ? (tenantRes.rows[0]["tenant_id"] as string | null) : null;
  if (tenantId == null) {
    throw new Error("profile has no tenant");
  }

  // -- Find the lead, scoped to tenant. lower() stays in SQL so NULL
  //    semantics match Postgres: lower(email) = lower(NULL) never matches. --
  const leadRes = await client.execute({
    sql: `SELECT id FROM leads WHERE lower(email) = lower(?) AND tenant_id = ? LIMIT 1`,
    args: [fromEmail, tenantId],
  });
  let leadId = leadRes.rows.length > 0 ? (leadRes.rows[0]["id"] as string) : null;

  const interactionId = crypto.randomUUID();

  // jsonb_build_object('from_identity', ..., 'classification', ..., 'profile_id', ...)
  // SQL NULLs become JSON nulls, exactly as jsonb_build_object does.
  const metadata = JSON.stringify({
    from_identity: fromEmail,
    classification: classification,
    profile_id: profileId,
  });

  // -- All writes commit or roll back together: libsql batch('write') runs in
  //    a single transaction, mirroring the PL/pgSQL function body. -----------
  const writes: Array<{ sql: string; args: Array<string | number | null> }> = [];

  // Bump secret usage (the source deliberately does NOT re-filter revoked_at here)
  writes.push({
    sql: `UPDATE n8n_webhook_secrets
             SET last_used_at = ?, use_count = use_count + 1
           WHERE profile_id = ? AND secret_hash = ?`,
    args: [nowIso, profileId, secretHash],
  });

  if (leadId === null) {
    leadId = crypto.randomUUID();
    // split_part(p_from_email, '@', 1) — whole string when '@' is absent,
    // '' when it starts with '@' — String.split matches both behaviors.
    const leadName = fromEmail === null ? null : fromEmail.split("@")[0];
    writes.push({
      sql: `INSERT INTO leads (id, tenant_id, email, name, status, source, score)
            VALUES (?, ?, ?, ?, 'new', 'n8n_inbound', 50)`,
      args: [leadId, tenantId, fromEmail, leadName],
    });
  }

  writes.push({
    sql: `INSERT INTO lead_interactions
            (id, tenant_id, lead_id, type, channel, subject, content, agent_source, metadata, created_at)
          VALUES (?, ?, ?, 'email_received', 'email', ?, ?, 'n8n', ?, ?)`,
    args: [interactionId, tenantId, leadId, subject, body, metadata, receivedAt],
  });

  // ON CONFLICT (profile_id, service) is backed by the unique index
  // integrations_health_profile_id_service_key in the Turso schema.
  writes.push({
    sql: `INSERT INTO integrations_health (tenant_id, profile_id, service, status, last_ping_at)
          VALUES (?, ?, 'n8n_inbound', 'healthy', ?)
          ON CONFLICT (profile_id, service) DO UPDATE SET
            tenant_id = excluded.tenant_id,
            status = 'healthy',
            last_ping_at = ?,
            last_error = NULL,
            updated_at = ?`,
    args: [tenantId, profileId, nowIso, nowIso, nowIso],
  });

  await client.batch(writes, "write");

  // RETURNS uuid — supabase-js callers receive this scalar as { data }.
  return interactionId;
}
/**
 * Port of public.record_outbound_from_gateway_v1 (PL/pgSQL, SECURITY DEFINER)
 * to @libsql/client over the 1:1-transpiled Turso schema.
 *
 * Postgres source: database/rpc_sources/bravo__record_outbound_from_gateway_v1.sql
 * resolve_tenant_for_profile is inlined (database/019_tenant_propagation.sql:33):
 *   SELECT tenant_id FROM user_profiles WHERE id = p_profile_id LIMIT 1
 *
 * Returns the interaction id (uuid TEXT) — supabase-js callers see { data: <uuid> }.
 * Reads run first; every write is collected into one client.batch(_, "write"),
 * which libsql executes transactionally (all-or-nothing, like the PG function body).
 */
export async function record_outbound_from_gateway_v1(
  client: Client,
  args: Record<string, unknown>,
): Promise<unknown> {
  // Postgres named-arg semantics: omitted arg -> DEFAULT, explicit null -> null.
  const has = (k: string) => k in args && args[k] !== undefined;

  const pProfileId = (args.p_profile_id ?? null) as string | null;
  const pSecretHash = (args.p_secret_hash ?? null) as string | null;
  const pToEmail = (args.p_to_email ?? null) as string | null;
  const pSubject = (args.p_subject ?? null) as string | null;
  const pBodyPreview = (args.p_body_preview ?? null) as string | null;
  const pLeadId = has("p_lead_id") ? ((args.p_lead_id ?? null) as string | null) : null;
  const pStatus = has("p_status") ? ((args.p_status ?? null) as string | null) : "sent";
  const pChannel = has("p_channel") ? ((args.p_channel ?? null) as string | null) : "email";
  const pAgentSource = has("p_agent_source")
    ? ((args.p_agent_source ?? null) as string | null)
    : "send_gateway";
  const pExistingInteractionId = has("p_existing_interaction_id")
    ? ((args.p_existing_interaction_id ?? null) as string | null)
    : null;

  // PG now() is transaction-start time: one value reused for every now() call.
  const nowIso = new Date().toISOString();

  // p_sent_at timestamptz DEFAULT now(); unparseable input throws (PG: 22007).
  let sentAt: string | null;
  if (!has("p_sent_at")) {
    sentAt = nowIso;
  } else if (args.p_sent_at === null) {
    sentAt = null;
  } else {
    const d = new Date(String(args.p_sent_at));
    if (Number.isNaN(d.getTime())) {
      throw new Error(`invalid input syntax for type timestamp: "${String(args.p_sent_at)}"`);
    }
    sentAt = d.toISOString();
  }

  // p_metadata jsonb DEFAULT '{}'. Explicit null propagates: in PG,
  // NULL || jsonb_build_object(...) IS NULL, so metadata inserts as NULL.
  let pMetadata: Record<string, unknown> | null;
  if (!has("p_metadata")) {
    pMetadata = {};
  } else if (args.p_metadata === null) {
    pMetadata = null;
  } else if (typeof args.p_metadata === "string") {
    pMetadata = JSON.parse(args.p_metadata) as Record<string, unknown>;
  } else {
    pMetadata = args.p_metadata as Record<string, unknown>;
  }

  // 1) Auth — validate secret hash (fail closed). ERRCODE 42501 in PG.
  const secretRes = await client.execute({
    sql:
      "SELECT 1 AS ok FROM n8n_webhook_secrets " +
      "WHERE profile_id = ? AND secret_hash = ? AND revoked_at IS NULL LIMIT 1",
    args: [pProfileId, pSecretHash],
  });
  if (secretRes.rows.length === 0) {
    throw new Error("invalid_outbound_secret");
  }

  // 2) Resolve tenant (resolve_tenant_for_profile inlined). ERRCODE 22023 in PG.
  const tenantRes = await client.execute({
    sql: "SELECT tenant_id FROM user_profiles WHERE id = ? LIMIT 1",
    args: [pProfileId],
  });
  const tenantId = (tenantRes.rows[0]?.tenant_id ?? null) as string | null;
  if (tenantId === null) {
    throw new Error("profile has no tenant");
  }

  // 3) Action type per channel (CASE ... ELSE 'email_sent').
  const actionType =
    pChannel === "email" ? "email_sent"
    : pChannel === "dm" ? "dm_sent"
    : pChannel === "linkedin" ? "linkedin_sent"
    : pChannel === "sms" ? "sms_sent"
    : pChannel === "call" ? "call_made"
    : "email_sent";

  let leadId: string | null = null; // stays null on the dedup path (matches PG)
  let interactionId: string;
  const writes: { sql: string; args: Array<string | number | null> }[] = [];

  // Bump secret usage — PG updates every matching row, revoked or not.
  writes.push({
    sql:
      "UPDATE n8n_webhook_secrets SET last_used_at = ?, use_count = use_count + 1 " +
      "WHERE profile_id = ? AND secret_hash = ?",
    args: [nowIso, pProfileId, pSecretHash],
  });

  if (pExistingInteractionId !== null) {
    // DEDUP PATH — operator's local insert already wrote the row.
    // PG does not verify the row exists; a 0-row UPDATE still returns the id.
    writes.push({
      sql: "UPDATE lead_interactions SET tenant_id = COALESCE(tenant_id, ?) WHERE id = ?",
      args: [tenantId, pExistingInteractionId],
    });
    interactionId = pExistingInteractionId;
  } else {
    if (pLeadId !== null) {
      leadId = pLeadId;
    } else {
      const leadRes = await client.execute({
        sql: "SELECT id FROM leads WHERE lower(email) = lower(?) AND tenant_id = ? LIMIT 1",
        args: [pToEmail, tenantId],
      });
      leadId = (leadRes.rows[0]?.id ?? null) as string | null;
      if (leadId === null) {
        // CHANGED IN 030: status='archived' (was 'new') — outbound to an unknown
        // address tracks the interaction but does NOT pollute the active pipeline.
        leadId = crypto.randomUUID();
        writes.push({
          sql:
            "INSERT INTO leads (id, tenant_id, email, name, status, source, score) " +
            "VALUES (?, ?, ?, ?, 'archived', 'outbound_gateway', 20)",
          // split_part(p_to_email, '@', 1)
          args: [leadId, tenantId, pToEmail, pToEmail === null ? null : pToEmail.split("@")[0]],
        });
      }
    }

    // metadata = p_metadata || jsonb_build_object('to_email',.., 'status',.., 'profile_id',..)
    const mergedMetadata =
      pMetadata === null
        ? null
        : JSON.stringify({
            ...pMetadata,
            to_email: pToEmail,
            status: pStatus,
            profile_id: pProfileId,
          });

    interactionId = crypto.randomUUID();
    writes.push({
      sql:
        "INSERT INTO lead_interactions " +
        "(id, tenant_id, lead_id, type, channel, subject, content, agent_source, metadata, created_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      args: [
        interactionId,
        tenantId,
        leadId,
        actionType,
        pChannel,
        pSubject,
        pBodyPreview,
        pAgentSource,
        mergedMetadata,
        sentAt,
      ],
    });
  }

  // Bump integrations_health for send_gateway (unique index: profile_id, service).
  writes.push({
    sql:
      "INSERT INTO integrations_health (id, profile_id, service, status, last_ping_at, metadata) " +
      "VALUES (?, ?, 'send_gateway', 'healthy', ?, ?) " +
      "ON CONFLICT (profile_id, service) DO UPDATE " +
      "SET status = excluded.status, last_ping_at = excluded.last_ping_at, metadata = excluded.metadata",
    args: [crypto.randomUUID(), pProfileId, nowIso, JSON.stringify({ last_action: actionType })],
  });

  // Publish agent_events for the live event tape (correlation_id = tenant_id::text).
  writes.push({
    sql:
      "INSERT INTO agent_events " +
      "(id, event_type, publisher_agent, severity, payload, correlation_id, published_at) " +
      "VALUES (?, 'outbound.recorded', ?, 'info', ?, ?, ?)",
    args: [
      crypto.randomUUID(),
      pAgentSource,
      JSON.stringify({
        lead_id: leadId,
        interaction_id: interactionId,
        channel: pChannel,
        to_email: pToEmail,
        subject: pSubject,
      }),
      tenantId,
      nowIso,
    ],
  });

  await client.batch(writes, "write"); // transactional in libsql: all writes or none

  return interactionId; // RETURNS uuid -> supabase-js callers receive { data: interactionId }
}
export async function record_tenant_cron_run(client: Client, args: Record<string, unknown>): Promise<unknown> {
  const p_job_id = (args.p_job_id ?? null) as string | null;
  const p_tenant_id = (args.p_tenant_id ?? null) as string | null;
  const p_status = (args.p_status ?? null) as string | null;
  const p_output = (args.p_output ?? null) as string | null;
  const p_error = (args.p_error ?? null) as string | null;

  // PL/pgSQL: IF p_status NOT IN ('success','error') THEN ... — with a NULL
  // p_status the predicate evaluates to NULL, which IF treats as false, so a
  // NULL status is NOT rejected in Postgres. Reproduce that exactly: only a
  // non-null status outside the set short-circuits.
  if (p_status !== null && p_status !== 'success' && p_status !== 'error') {
    return { ok: false, error: 'invalid_status' };
  }

  const nowIso = new Date().toISOString();

  // Single conditional UPDATE ... RETURNING — one statement, atomic in libsql,
  // mirroring the original's single-statement UPDATE with its implicit row lock.
  // tenant_id predicate preserved verbatim. updated_at is bumped here because
  // Postgres did it via trg_tenant_cron_jobs_updated_at, which was not
  // transpiled to the Turso schema.
  const result = await client.execute({
    sql: `UPDATE tenant_cron_jobs
             SET last_run_at = ?,
                 last_run_status = ?,
                 last_run_output = ?,
                 last_run_error = ?,
                 run_count = COALESCE(run_count, 0) + 1,
                 updated_at = ?
           WHERE id = ?
             AND tenant_id = ?
       RETURNING run_count`,
    args: [nowIso, p_status, p_output, p_error, nowIso, p_job_id, p_tenant_id],
  });

  const row = result.rows[0];
  const newCount = row === undefined ? null : row['run_count'];

  // PL/pgSQL: RETURNING run_count INTO v_new_count; IF v_new_count IS NULL →
  // no row matched (wrong id or other tenant).
  if (newCount === null || newCount === undefined) {
    return { ok: false, error: 'job_not_found_or_other_tenant' };
  }

  return { ok: true, run_count: Number(newCount) };
}
export async function redeem_pair_code(client: Client, args: Record<string, unknown>): Promise<unknown> {
  const p_code = (args.p_code ?? null) as string | null;
  const p_token_hash = (args.p_token_hash ?? null) as string | null;
  const p_label = (args.p_label ?? null) as string | null;
  const p_fingerprint = (args.p_fingerprint ?? null) as string | null;

  const nowIso = new Date().toISOString();

  // Mirrors the PL/pgSQL error precedence: NOT_FOUND -> CONSUMED -> EXPIRED.
  const assertRedeemable = (row: Record<string, unknown> | undefined): void => {
    if (!row || row.id == null) throw new Error('PCODE_NOT_FOUND');
    if (row.consumed_at != null) throw new Error('PCODE_CONSUMED');
    if (typeof row.expires_at === 'string' && row.expires_at < nowIso) throw new Error('PCODE_EXPIRED');
  };

  // Pre-flight read (stands in for SELECT ... FOR UPDATE; the batch below
  // re-validates every predicate atomically inside the write transaction).
  const pre = await client.execute({
    sql: 'SELECT id, tenant_id, auth_user_id, expires_at, consumed_at FROM bridge_pair_codes WHERE code = ? LIMIT 1',
    args: [p_code],
  });
  const codeRow = pre.rows[0] as unknown as Record<string, unknown> | undefined;
  assertRedeemable(codeRow);

  const codeId = String((codeRow as Record<string, unknown>).id);
  const tenantId = (codeRow as Record<string, unknown>).tenant_id as string;
  const authUserId = (codeRow as Record<string, unknown>).auth_user_id as string;

  const pairingId = crypto.randomUUID();
  const label = p_label ?? 'Local install'; // COALESCE: only NULL falls back, '' does not

  // Atomic compare-and-swap replacing FOR UPDATE + same-transaction INSERT/UPDATE.
  // libsql batch('write') is a single transaction: the INSERT fires only if the
  // code row is still unconsumed and unexpired AT TRANSACTION TIME; the UPDATE
  // consumes the code only if the INSERT fired. The client therefore sees one of:
  //   * success: code consumed AND pairing exists
  //   * failure: code untouched AND no pairing
  // INSERT precedes UPDATE so the consumed_by_pairing_id FK is satisfiable.
  const results = await client.batch(
    [
      {
        sql:
          'INSERT INTO bridge_pairings (id, tenant_id, user_id, label, bridge_token_hash, machine_fingerprint, last_seen_at) ' +
          'SELECT ?, bpc.tenant_id, bpc.auth_user_id, ?, ?, ?, ? ' +
          'FROM bridge_pair_codes bpc ' +
          'WHERE bpc.id = ? AND bpc.consumed_at IS NULL AND bpc.expires_at >= ?',
        args: [pairingId, label, p_token_hash, p_fingerprint, nowIso, codeId, nowIso],
      },
      {
        sql:
          'UPDATE bridge_pair_codes ' +
          'SET consumed_at = ?, consumed_by_pairing_id = ? ' +
          'WHERE id = ? AND consumed_at IS NULL ' +
          'AND EXISTS (SELECT 1 FROM bridge_pairings WHERE id = ?)',
        args: [nowIso, pairingId, codeId, pairingId],
      },
    ],
    'write'
  );

  if ((results[1]?.rowsAffected ?? 0) !== 1) {
    // Lost a race between the pre-flight read and the batch (a concurrent
    // redeemer consumed the code, or it expired in the gap). Re-read committed
    // state and raise the same error the Postgres FOR UPDATE path would raise.
    const post = await client.execute({
      sql: 'SELECT id, consumed_at, expires_at FROM bridge_pair_codes WHERE id = ? LIMIT 1',
      args: [codeId],
    });
    assertRedeemable(post.rows[0] as unknown as Record<string, unknown> | undefined);
    // Unreachable unless the row mutated in a way the CAS predicates exclude.
    throw new Error('redeem_pair_code: conditional consume failed');
  }

  // Resolve profile_id for response shape parity with /api/auth/pair.
  const prof = await client.execute({
    sql: 'SELECT id FROM user_profiles WHERE auth_user_id = ? LIMIT 1',
    args: [authUserId],
  });
  const profileId = prof.rows.length > 0 ? (prof.rows[0].id as string | null) : null;

  // RETURNS TABLE(...) with one RETURN QUERY row -> supabase-js data is an array of rows.
  return [
    {
      pairing_id: pairingId,
      tenant_id: tenantId,
      auth_user_id: authUserId,
      profile_id: profileId,
    },
  ];
}
export async function redeem_tenant_invite(
  client: Client,
  args: Record<string, unknown>,
): Promise<unknown> {
  // ---- args (mirror the PG signature) -------------------------------------
  const tokenHash = args["p_token_hash"];
  if (typeof tokenHash !== "string" || tokenHash === "") {
    throw new Error("redeem_tenant_invite: p_token_hash is required");
  }
  const redeemerAuthId = args["p_redeemer_auth_id"];
  if (typeof redeemerAuthId !== "string" || redeemerAuthId === "") {
    throw new Error("redeem_tenant_invite: p_redeemer_auth_id is required");
  }

  // PG: SELECT email INTO v_email FROM auth.users WHERE id = p_redeemer_auth_id;
  // auth.users was not migrated to Turso (cross-schema FKs dropped in transpile),
  // so the caller supplies the authenticated user's email (and optionally the
  // full_name from user metadata) from the app's auth layer. An absent email is
  // the same fail-closed refusal PG gives for an absent auth row.
  const redeemerEmail =
    typeof args["p_redeemer_email"] === "string" ? (args["p_redeemer_email"] as string) : null;
  if (redeemerEmail === null) {
    return { ok: false, error: "auth_user_not_found" };
  }
  const redeemerFullName =
    typeof args["p_redeemer_full_name"] === "string"
      ? (args["p_redeemer_full_name"] as string)
      : null;

  // PG now() is transaction-fixed — capture once, reuse everywhere.
  const nowIso = new Date().toISOString();

  // expires_at may carry "+00:00" (rows ETL'd from PostgREST) or "Z"
  // (Turso-native strftime default). strftime normalizes both to millisecond-Z
  // so the TEXT comparison is exact; an unparseable expires_at yields NULL,
  // which is falsy -> treated as expired (fail-closed).
  const notExpired = `strftime('%Y-%m-%dT%H:%M:%fZ', "expires_at") > ?`;

  // PG retry branch: same user redeeming the same token again, gated on
  // expires_at so an expired token is inert even on the friendly response.
  const retrySelect = async (): Promise<Record<string, unknown> | null> => {
    const r = await client.execute({
      sql:
        `SELECT "id", "tenant_id", "team_role" FROM "tenant_invites" ` +
        `WHERE "token_hash" = ? AND "redeemed_by" = ? AND "revoked_at" IS NULL ` +
        `AND ${notExpired} LIMIT 1`,
      args: [tokenHash, redeemerAuthId, nowIso],
    });
    return (r.rows[0] as unknown as Record<string, unknown> | undefined) ?? null;
  };

  const profileIdOf = async (): Promise<string | null> => {
    const r = await client.execute({
      sql: `SELECT "id" FROM "user_profiles" WHERE "auth_user_id" = ? LIMIT 1`,
      args: [redeemerAuthId],
    });
    const row = r.rows[0] as unknown as Record<string, unknown> | undefined;
    return row ? String(row["id"]) : null;
  };

  const alreadyRedeemedResponse = async (inv: Record<string, unknown>) => ({
    ok: true,
    tenant_id: String(inv["tenant_id"]),
    team_role: String(inv["team_role"]),
    profile_id: await profileIdOf(), // PG: SELECT id INTO v_profile — null when no row
    already_redeemed: true,
  });

  // PG: SELECT * ... WHERE token_hash = ? AND redeemed_at IS NULL AND
  //     revoked_at IS NULL AND expires_at > now() FOR UPDATE;
  // token_hash is UNIQUE (tenant_invites_token_hash_key) — at most one row.
  // The FOR UPDATE lock is replaced by the compare-and-swap claim below.
  const sel = await client.execute({
    sql:
      `SELECT "id", "tenant_id", "email", "team_role", "created_by" ` +
      `FROM "tenant_invites" ` +
      `WHERE "token_hash" = ? AND "redeemed_at" IS NULL AND "revoked_at" IS NULL ` +
      `AND ${notExpired} LIMIT 1`,
    args: [tokenHash, nowIso],
  });
  const invite = (sel.rows[0] as unknown as Record<string, unknown> | undefined) ?? null;

  if (invite === null) {
    const again = await retrySelect();
    if (again !== null) return alreadyRedeemedResponse(again);
    return { ok: false, error: "invalid_or_expired" };
  }

  // PG: lower(trim(v_invite.email)) <> lower(trim(v_email))
  // trim() in PG strips spaces only — replicate exactly (JS .trim() is wider).
  const pgTrimLower = (s: string) => s.replace(/^ +| +$/g, "").toLowerCase();
  const inviteEmail = invite["email"];
  if (
    inviteEmail !== null &&
    inviteEmail !== undefined &&
    pgTrimLower(String(inviteEmail)) !== pgTrimLower(redeemerEmail)
  ) {
    return { ok: false, error: "email_mismatch" };
  }

  const existingProfileId = await profileIdOf();
  const inviteId = String(invite["id"]);
  const tenantId = String(invite["tenant_id"]);
  const teamRole = String(invite["team_role"]);
  const createdBy = String(invite["created_by"]);

  // The profile statement runs second in the same transactional batch;
  // changes() at that point is the claim UPDATE's affected-row count, so the
  // profile mutation applies ONLY when this call actually won the redemption.
  // A lost race therefore mutates nothing — mirroring PG, where the profile
  // upsert sits behind the FOR UPDATE lock.
  let newProfileId: string | null = null;
  const statements: Array<{ sql: string; args: Array<string | number> }> = [
    {
      // Compare-and-swap claim: re-asserts every predicate the PG SELECT
      // evaluated under lock. rowsAffected === 0 -> lost the race.
      sql:
        `UPDATE "tenant_invites" SET "redeemed_at" = ?, "redeemed_by" = ? ` +
        `WHERE "id" = ? AND "redeemed_at" IS NULL AND "revoked_at" IS NULL AND ${notExpired}`,
      args: [nowIso, redeemerAuthId, inviteId, nowIso],
    },
  ];

  if (existingProfileId === null) {
    // PG: INSERT ... SELECT FROM auth.users — email is provably non-null here
    // (the auth_user_not_found gate passed), so PG's 'pending+...@oasis.invalid'
    // and 'New member' fallbacks are unreachable and not replicated.
    // agents_enabled / prospect_focus: Postgres defaults ARRAY['bravo'] /
    // ARRAY['service_trades'] were dropped in transpile (NOT NULL, no default
    // in Turso) — supplied explicitly as JSON text.
    newProfileId = crypto.randomUUID();
    statements.push({
      sql:
        `INSERT INTO "user_profiles" ` +
        `("id", "auth_user_id", "email", "full_name", "tenant_id", "team_role", ` +
        `"invited_by", "joined_at", "is_owner", "agents_enabled", "prospect_focus") ` +
        `SELECT ?, ?, ?, ?, ?, ?, ?, ?, 0, '["bravo"]', '["service_trades"]' ` +
        `WHERE changes() = 1`,
      args: [
        newProfileId,
        redeemerAuthId,
        redeemerEmail,
        redeemerFullName ?? redeemerEmail, // COALESCE(meta->>'full_name', email, ...)
        tenantId,
        teamRole,
        createdBy,
        nowIso,
      ],
    });
  } else {
    statements.push({
      sql:
        `UPDATE "user_profiles" SET "tenant_id" = ?, "team_role" = ?, "invited_by" = ?, ` +
        `"joined_at" = COALESCE("joined_at", ?), "is_owner" = 0 ` +
        `WHERE "id" = ? AND changes() = 1`,
      args: [tenantId, teamRole, createdBy, nowIso, existingProfileId],
    });
  }

  // batch is transactional in libsql: claim + profile upsert commit or roll
  // back together — the single-transaction atomicity of the PG function.
  const results = await client.batch(statements, "write");

  if (results[0].rowsAffected === 0) {
    // Lost the race — PG's NOT FOUND path after FOR UPDATE serialization:
    // friendly response if this same user already redeemed it, else invalid.
    const again = await retrySelect();
    if (again !== null) return alreadyRedeemedResponse(again);
    return { ok: false, error: "invalid_or_expired" };
  }

  return {
    ok: true,
    tenant_id: tenantId,
    team_role: teamRole,
    profile_id: existingProfileId ?? newProfileId,
    already_redeemed: false,
  };
}
export async function signup_tenant(client: Client, args: Record<string, unknown>): Promise<unknown> {
  // PostgREST would reject a call missing a no-default parameter; fail closed the same way.
  for (const k of ['p_auth_user_id', 'p_email', 'p_full_name']) {
    if (!(k in args)) throw new Error(`signup_tenant: missing required argument ${k}`);
  }

  const pAuthUserId = args.p_auth_user_id == null ? null : String(args.p_auth_user_id);
  const pEmail = args.p_email == null ? null : String(args.p_email);
  const pFullName = args.p_full_name == null ? null : String(args.p_full_name);
  // p_brand DEFAULT 'OASIS AI' — default applies only when the key is absent; an explicit null stays null (and hits NOT NULL, as in PG).
  const pBrand = 'p_brand' in args ? (args.p_brand == null ? null : String(args.p_brand)) : 'OASIS AI';
  const pSlugRaw = 'p_slug' in args && args.p_slug != null ? String(args.p_slug) : null;

  // v_slug := COALESCE(NULLIF(trim(p_slug), ''), regexp_replace(lower(split_part(p_email,'@',1)), '[^a-z0-9-]+', '-', 'g'))
  let slug: string | null = null;
  const trimmed = pSlugRaw == null ? null : pSlugRaw.trim();
  if (trimmed != null && trimmed !== '') {
    slug = trimmed;
  } else if (pEmail != null) {
    slug = pEmail.split('@')[0].toLowerCase().replace(/[^a-z0-9-]+/g, '-');
  }
  // If both p_slug and p_email are null, slug stays null and the tenants.slug NOT NULL
  // constraint raises — exactly as the Postgres function would.

  // substr(p_auth_user_id::text, 1, 8)
  const suffix = pAuthUserId == null ? null : pAuthUserId.slice(0, 8);
  // split_part(p_full_name, ' ', 1)
  const displayName = pFullName == null ? null : pFullName.split(' ')[0];

  const tenantId = crypto.randomUUID();
  const profileId = crypto.randomUUID();
  const now = new Date().toISOString();

  // libsql batch runs in a single transaction: both inserts commit or neither does,
  // matching PL/pgSQL single-function atomicity. The slug-collision check is evaluated
  // inside the INSERT itself (CASE WHEN EXISTS), so check + insert are atomic; the
  // third statement reads back whichever slug won, inside the same transaction.
  const rs = await client.batch(
    [
      {
        sql: `INSERT INTO tenants (id, slug, name, plan_tier, purchase_status, created_at, updated_at)
              VALUES (
                :id,
                CASE WHEN EXISTS (SELECT 1 FROM tenants WHERE slug = :slug)
                     THEN :slug || '-' || :suffix
                     ELSE :slug
                END,
                :name, 'starter', 'pending', :now, :now
              )`,
        args: { id: tenantId, slug, suffix, name: pBrand, now },
      },
      {
        sql: `INSERT INTO user_profiles (
                id, auth_user_id, email, full_name, display_name, brand, role,
                tenant_id, agents_enabled, primary_agent, prospect_focus,
                created_at, updated_at
              )
              VALUES (
                :id, :auth_user_id, :email, :full_name, :display_name, :brand, 'operator',
                :tenant_id, :agents_enabled, 'bravo', :prospect_focus,
                :now, :now
              )`,
        args: {
          id: profileId,
          auth_user_id: pAuthUserId,
          email: pEmail,
          full_name: pFullName,
          display_name: displayName,
          brand: pBrand,
          tenant_id: tenantId,
          // text[] columns are stored as JSON text in the Turso schema.
          agents_enabled: JSON.stringify(['bravo']),
          // Postgres relied on the column default ARRAY['service_trades']; the transpiler
          // dropped it (column is NOT NULL, no default in SQLite) so it must be supplied here.
          prospect_focus: JSON.stringify(['service_trades']),
          now,
        },
      },
      {
        sql: `SELECT slug FROM tenants WHERE id = :id`,
        args: { id: tenantId },
      },
    ],
    'write'
  );

  const slugRow = rs[2]?.rows?.[0] as Record<string, unknown> | undefined;
  const finalSlug = slugRow ? slugRow['slug'] : slug;

  // RETURNS jsonb — supabase-js callers receive this object as { data }.
  return {
    tenant_id: tenantId,
    profile_id: profileId,
    slug: finalSlug,
  };
}

/**
 * MANIFEST
 *   approve_sunbiz_draft               ported-unverified  writes=True  confidence=high
 *   close_website_deal                 hand-ported (147 comp v2)  writes=True  confidence=high
 *   consume_texttorrent_rate_token     ported-unverified  writes=True  confidence=high
 *   find_similar_merchants             ported-unverified  writes=False  confidence=high
 *   force_materialize_today_plan       ported-unverified  writes=True  confidence=high
 *   log_tenant_event                   ported-unverified  writes=True  confidence=high
 *   materialize_today_plan             ported-unverified  writes=True  confidence=high
 *   patch_tenant_record_data           ported-unverified  writes=True  confidence=high
 *   preview_tenant_invite              ported-unverified  writes=False  confidence=high
 *   record_inbound_from_n8n_v2         ported-unverified  writes=True  confidence=high
 *   record_outbound_from_gateway_v1    ported-unverified  writes=True  confidence=high
 *   record_tenant_cron_run             ported-unverified  writes=True  confidence=high
 *   redeem_pair_code                   ported-unverified  writes=True  confidence=high
 *   redeem_tenant_invite               ported-unverified  writes=True  confidence=high
 *   signup_tenant                      ported-unverified  writes=True  confidence=high
 */
export const TURSO_RPC_SHIM: Record<string, (client: Client, args: Record<string, unknown>) => Promise<unknown>> = {
  approve_sunbiz_draft,
  close_website_deal,
  consume_texttorrent_rate_token,
  find_similar_merchants,
  force_materialize_today_plan,
  log_tenant_event,
  materialize_today_plan,
  patch_tenant_record_data,
  preview_tenant_invite,
  record_inbound_from_n8n_v2,
  record_outbound_from_gateway_v1,
  record_tenant_cron_run,
  redeem_pair_code,
  redeem_tenant_invite,
  signup_tenant,
};
