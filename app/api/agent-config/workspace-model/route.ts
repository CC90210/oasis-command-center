/**
 * POST /api/agent-config/workspace-model  { model }
 *
 * Settings > AI brain's model switch: the model every department chat and
 * Slack mention sends, on the workspace AI account's own provider and saved
 * key (lib/ai/workspace-account.ts). Switching PROVIDER is connecting that
 * provider's key on its card (/api/agent-config/bulk-provider); this changes
 * only the model, without pasting the key again.
 *
 * ONE SOURCE (CC, 2026-10-09). AI brain is the one place that decides what
 * powers the departments; lib/ai/department-brain.ts is how every screen names
 * it, and lib/os/department-agent.ts sends exactly it.
 *
 *   - Owners and admins only (the team-wide connect's rule), 403 otherwise.
 *   - The model must be one the registry offers for that provider and not gone
 *     or ending soon (lib/ai/model-registry.ts saveCheck), 400 with its plain
 *     sentence otherwise.
 *   - BEFORE anything is written, the saved key answers one short department
 *     reply on the new model (lib/agents/provider-probe.ts
 *     probeDepartmentAnswer, the same "Test" AI brain runs): a model the
 *     departments would fail on is never switched to (422, the test's own
 *     sentence).
 *   - One statement, guarded on the key as read (changeWorkspaceModelInOneStep):
 *     a reconnect or disconnect in another window meanwhile changes nothing (409).
 *
 * Every non-ok answer carries one plain `message`, the only thing the card shows.
 * Returns { ok, provider, model, label }.
 */

import { NextRequest, NextResponse } from "next/server";
import { getAuthedSupabase } from "@/lib/supabase-server";
import { canManageTeam, getSessionContext } from "@/lib/team";
import { decryptField } from "@/lib/field-encryption";
import { hasUsableKey, changeWorkspaceModelInOneStep, readWorkspaceAiAccount, type WorkspaceAiAccount } from "@/lib/ai/workspace-account";
import { isRegistryProvider, modelInfo, saveCheck } from "@/lib/ai/model-registry";
import { probeDepartmentAnswer } from "@/lib/agents/provider-probe";
import { billingForKey, modelCallMeter } from "@/lib/ai/usage";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const SIGNED_OUT = "Your session ended. Sign in again, then try again.";
const NOT_SAVED = "The model couldn't be switched just now. Nothing was changed. Try again in a moment.";
const CONFLICT = "The AI account was changed in another window, so the model was not switched. Check the card, then try again.";

const fail = (status: number, error: string, message: string) => NextResponse.json({ ok: false, error, message }, { status });
const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

export async function POST(req: NextRequest) {
  const ctx = await getSessionContext();
  if (!ctx?.tenantId) return fail(401, "unauthorized", SIGNED_OUT);
  if (!(ctx.isOwner || canManageTeam(ctx.teamRole, ctx.adminAccess))) {
    return fail(403, "admin_required", "Only an owner or admin can change the model your departments use.");
  }
  const tenantId = ctx.tenantId;

  let body: { model?: unknown };
  try {
    body = (await req.json()) as { model?: unknown };
  } catch {
    return fail(400, "invalid_json", "That request could not be read. Try again.");
  }
  const model = typeof body.model === "string" ? body.model.trim() : "";
  if (!model) return fail(400, "missing_model", "Pick a model.");

  let account: WorkspaceAiAccount | null;
  try {
    account = await readWorkspaceAiAccount(tenantId);
  } catch (err) {
    console.error("[workspace-model.read]", { tenantId, error: errText(err) });
    return fail(503, "config_unavailable", "We could not read this workspace's AI account just now. Nothing was changed.");
  }
  if (!hasUsableKey(account)) {
    return fail(409, "no_account", "No AI account is connected yet. Connect one first, then pick its model.");
  }
  const provider = account.provider;
  if (!isRegistryProvider(provider)) {
    return fail(400, "provider_not_switchable", "This AI account's model can't be switched here.");
  }
  const check = saveCheck(provider, model);
  if (!check.ok) return fail(400, "model_not_offered", check.message);
  if (!check.known) return fail(400, "unknown_model", "That model is not one we offer for this AI account. Pick a listed model.");
  const label = modelInfo(provider, model)?.label ?? model;
  if (model === account.model) return NextResponse.json({ ok: true, provider, model, label, unchanged: true });

  let key: string;
  try {
    key = decryptField(account.encryptedApiKey);
  } catch {
    return fail(500, "key_unreadable", "The saved AI key could not be read. Use Replace key to enter it again.");
  }
  // The departments' own question, on the new model, before anything changes.
  const tested = await probeDepartmentAnswer(provider, key, {
    model,
    meter: modelCallMeter({ tenantId, surface: "probe", ...billingForKey(provider, "tenant"), userId: ctx.authUserId }),
  });
  if (!tested.ok) {
    return NextResponse.json(
      { ok: false, error: "model_test_failed", code: tested.code, message: `${label} did not pass the test, so nothing was changed. ${tested.message}` },
      { status: 422 },
    );
  }

  let outcome: { committed: boolean; changed: string[] };
  try {
    outcome = await changeWorkspaceModelInOneStep({ tenantId, account, model });
  } catch (err) {
    console.error("[workspace-model.write]", { tenantId, provider, error: errText(err) });
    return fail(500, "save_failed", NOT_SAVED);
  }
  if (!outcome.committed) return fail(409, "conflict", CONFLICT);

  try {
    const authed = await getAuthedSupabase();
    await authed.rpc("log_tenant_event", {
      p_tenant_id: tenantId,
      p_action_type: "agent_config.tenant_model",
      p_target_table: "agent_model_config",
      p_target_id: `${tenantId}:tenant:${provider}:model`,
      p_before: { model: account.model },
      p_after: { provider, model, applied_to: outcome.changed },
    });
  } catch {
    // audit-log soft-fail, as the connect route does
  }
  return NextResponse.json({ ok: true, provider, model, label });
}
