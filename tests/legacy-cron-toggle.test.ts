import assert from "node:assert/strict";
import type { SupabaseClient } from "@supabase/supabase-js";
import { toggleLegacyCronWithAudit } from "../lib/automations/cron-toggle-legacy";

type Row = Record<string, unknown>;
type RpcResult = { data: unknown; error: { message: string } | null };

class FakeRowQuery {
  private readonly filters: Array<[string, unknown]> = [];

  constructor(
    private readonly rows: Row[],
  ) {}

  select(_columns = "*") {
    return this;
  }

  eq(column: string, value: unknown) {
    this.filters.push([column, value]);
    return this;
  }

  async maybeSingle() {
    const row = this.rows.find((candidate) =>
      this.filters.every(([column, value]) => candidate[column] === value));
    return { data: row ? { ...row } : null, error: null };
  }
}

class FakeLegacyDb {
  rows: Record<string, Row[]> = { cron_jobs: [], tenant_cron_jobs: [] };
  rpcCalls: Array<{ name: string; args: Row }> = [];
  rpcResult: RpcResult = { data: null, error: null };

  from(table: string) {
    return new FakeRowQuery(this.rows[table] ?? []);
  }

  async rpc(name: string, args: Row): Promise<RpcResult> {
    this.rpcCalls.push({ name, args });
    return this.rpcResult;
  }

  asClient(): SupabaseClient {
    return this as unknown as SupabaseClient;
  }
}

const baseInput = {
  source: "tenant" as const,
  id: "tenant-job",
  tenantId: "tenant-a",
  enabled: false,
  actorEmail: "operator@example.com",
  actorUserId: "operator-1",
};

function successPayload(row: Row, previousEnabled: boolean, enabled: boolean) {
  return { ok: true, row, previousEnabled, enabled };
}

async function main() {
  {
    const db = new FakeLegacyDb();
    db.rows.tenant_cron_jobs.push({
      id: "tenant-job",
      tenant_id: "tenant-a",
      name: "Daily briefing",
      enabled: true,
    });
    db.rpcResult.data = successPayload({
      id: "tenant-job",
      tenant_id: "tenant-a",
      name: "Daily briefing",
      enabled: false,
    }, true, false);
    const result = await toggleLegacyCronWithAudit(db.asClient(), baseInput);
    assert.equal(result.ok, true);
    assert.equal(db.rpcCalls.length, 1);
    assert.equal(db.rpcCalls[0].name, "toggle_cron_job_with_audit_v1");
    assert.deepEqual(db.rpcCalls[0].args, {
      p_source: "tenant",
      p_id: "tenant-job",
      p_tenant_id: "tenant-a",
      p_enabled: false,
      p_expected_name: "Daily briefing",
      p_expected_enabled: true,
      p_actor_user_id: "operator-1",
      p_actor_email: "operator@example.com",
    });
  }

  {
    const db = new FakeLegacyDb();
    db.rows.cron_jobs.push({
      id: "empire-job",
      tenant_id: "tenant-a",
      name: "Maven — Carousel Post",
      is_active: true,
    });
    db.rpcResult.data = successPayload({
      id: "empire-job",
      tenant_id: "tenant-a",
      name: "Maven — Carousel Post",
      is_active: false,
    }, true, false);
    const result = await toggleLegacyCronWithAudit(db.asClient(), {
      ...baseInput,
      source: "empire",
      id: "empire-job",
    });
    assert.equal(result.ok, true);
    assert.equal(db.rpcCalls[0].args.p_expected_enabled, true);
  }

  {
    const db = new FakeLegacyDb();
    db.rows.tenant_cron_jobs.push({
      id: "tenant-job",
      tenant_id: "tenant-b",
      name: "Other tenant",
      enabled: true,
    });
    const result = await toggleLegacyCronWithAudit(db.asClient(), baseInput);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.status, 404);
    assert.equal(db.rpcCalls.length, 0, "wrong-tenant pre-read must never reach the RPC");
  }

  {
    const db = new FakeLegacyDb();
    db.rows.cron_jobs.push({
      id: "empire-job",
      tenant_id: "tenant-a",
      name: "Instagram DM Closer",
      is_active: false,
    });
    const result = await toggleLegacyCronWithAudit(db.asClient(), {
      ...baseInput,
      source: "empire",
      id: "empire-job",
      enabled: true,
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.status, 409);
    assert.equal(db.rpcCalls.length, 0, "daemon interlock must refuse before mutation");
  }

  {
    const db = new FakeLegacyDb();
    db.rows.tenant_cron_jobs.push({
      id: "tenant-job",
      tenant_id: "tenant-a",
      name: "Concurrent job",
      enabled: true,
    });
    db.rpcResult.data = {
      ok: false,
      status: 409,
      body: { ok: false, error: "cron_toggle_concurrent_update" },
    };
    const result = await toggleLegacyCronWithAudit(db.asClient(), baseInput);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.body.error, "cron_toggle_concurrent_update");
  }

  {
    const db = new FakeLegacyDb();
    db.rows.tenant_cron_jobs.push({
      id: "tenant-job",
      tenant_id: "tenant-a",
      name: "RPC failure",
      enabled: true,
    });
    db.rpcResult = { data: null, error: { message: "transaction aborted" } };
    await assert.rejects(
      toggleLegacyCronWithAudit(db.asClient(), baseInput),
      /cron_toggle_rpc_failed:transaction aborted/,
    );
  }

  {
    const db = new FakeLegacyDb();
    db.rows.tenant_cron_jobs.push({
      id: "tenant-job",
      tenant_id: "tenant-a",
      name: "Malformed off response",
      enabled: true,
    });
    db.rpcResult.data = {
      ok: true,
      row: {
        id: "tenant-job",
        tenant_id: "tenant-a",
        name: "Malformed off response",
      },
      previousEnabled: true,
    };
    await assert.rejects(
      toggleLegacyCronWithAudit(db.asClient(), baseInput),
      /cron_toggle_rpc_readback_mismatch/,
      "missing false fields must not be coerced into confirmed disabled state",
    );
  }

  {
    const db = new FakeLegacyDb();
    db.rows.tenant_cron_jobs.push({
      id: "tenant-job",
      tenant_id: "tenant-a",
      name: "Stale previous state",
      enabled: true,
    });
    db.rpcResult.data = successPayload({
      id: "tenant-job",
      tenant_id: "tenant-a",
      name: "Stale previous state",
      enabled: false,
    }, false, false);
    await assert.rejects(
      toggleLegacyCronWithAudit(db.asClient(), baseInput),
      /cron_toggle_rpc_readback_mismatch/,
      "RPC must echo the exact state the pre-read supplied to its CAS",
    );
  }

  console.log("legacy-cron-toggle: atomic RPC dispatch contract passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
