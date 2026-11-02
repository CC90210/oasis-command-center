/** One-shot approved SMS. No retries: Quo has no provider idempotency key. */
import "server-only";
import { resolveOsViewerFor } from "@/components/os/department/viewer";
import { currentCapabilityViewer } from "@/lib/os/agent-capabilities";
import { OS_DEPARTMENTS } from "@/lib/os/departments";
import { assertSmsAccess } from "@/lib/os/desk/sms-access";
import { getQuoCredentials, quoStopIntakeReadiness, sendQuoSms } from "@/lib/integrations/quo";
import { validateSendSmsPayload } from "./rules";
import type { Executor, ExecutorOutcome } from "./executors";

export type SmsExecutorDeps = {
  viewer: typeof resolveOsViewerFor;
  access: typeof assertSmsAccess;
  credentials: typeof getQuoCredentials;
  stopReadiness: typeof quoStopIntakeReadiness;
  send: typeof sendQuoSms;
};
const defaults: SmsExecutorDeps = { viewer: resolveOsViewerFor, access: assertSmsAccess, credentials: getQuoCredentials, stopReadiness: quoStopIntakeReadiness, send: sendQuoSms };
const fail = (reason: string, message: string): ExecutorOutcome => ({ ok: false, result: { outcome: "failed", reason, message, provider: "quo" } });

export const sendSmsExecutor: Executor = {
  // Async readiness is checked before the send. A saved key alone is never a promise.
  readiness: () => null,
  async run(ctx) {
    const deps = { ...defaults, ...ctx.deps.sms };
    const checked = validateSendSmsPayload(ctx.payload);
    if (!checked.ok) return fail("payload_invalid", "The stored text or recipient is invalid. Nothing was sent.");
    const dept = OS_DEPARTMENTS.find(d => d.key === ctx.approval.department_key);
    if (!dept || !ctx.approver?.userId) return fail("approver_required", "A current workspace member must approve this text.");
    const viewer = await deps.viewer(ctx.tenant.id, ctx.approver.userId);
    if (!viewer.ok) return fail("approver_unavailable", "The approving member no longer has access, or access could not be checked.");
    try {
      // Validates exact tenant/user/department in addition to the current role.
      const fresh = await currentCapabilityViewer(viewer, dept, deps.viewer);
      if (fresh.surface.tenantId !== ctx.tenant.id || fresh.surface.userId !== ctx.approver.userId) throw new Error("approver_scope_mismatch");
      await deps.access(fresh, dept, checked.value);
    } catch { return fail("sms_access_denied", "The current member, lead or department no longer permits this text. Nothing was sent."); }
    if (ctx.deps.isDryRun("quo")) return { ok: true, result: { outcome: "dry_run", provider: "quo", would_send: { to: checked.value.to } } };
    let credentials;
    try { credentials = await deps.credentials(ctx.tenant.id); }
    catch { return fail("quo_credentials_unavailable", "This workspace's Quo connection could not be read. Nothing was sent."); }
    if (credentials.tenantId !== ctx.tenant.id) return fail("quo_scope_mismatch", "The sending account could not be verified. Nothing was sent.");
    let intake;
    try { intake = await deps.stopReadiness(ctx.tenant.id, credentials); }
    catch { return fail("stop_intake_unavailable", "Incoming STOP protection could not be checked. Nothing was sent."); }
    if (!intake.ready) return fail("stop_intake_not_ready", "Incoming STOP protection is not ready. Check Quo in Settings > Connections; nothing was sent.");
    // The provider adapter re-checks the live switch, retired tenant and STOP list.
    // A thrown/ambiguous send is durably failed by executeApproval, never replayed.
    const sent = await deps.send(credentials, { to: checked.value.to, text: checked.value.body });
    if (!sent.ok) return fail(sent.code, sent.reason);
    return { ok: true, result: { outcome: "sent", provider: "quo", provider_status: sent.status, message_id: sent.id, from: sent.from } };
  },
};
