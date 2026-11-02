import "server-only";
import type { OsViewer } from "@/components/os/department/viewer";
import type { OsDepartment } from "@/lib/os/departments";
import type { SendSmsPayload } from "@/lib/os/approvals/rules";
import { departmentMayUse } from "@/lib/os/agent-access-store";
import { normalizePhoneE164 } from "@/lib/conversation-threading";
import { openLead } from "./reads";

/** The same member/lead restriction at proposal and execution, after a fresh seat check. */
export async function assertSmsAccess(viewer: OsViewer, dept: OsDepartment, payload: SendSmsPayload): Promise<void> {
  if (!viewer.surface.capabilities.canAct) throw new Error("read_only_member_cannot_propose");
  if (!["chief_of_staff", "sales", "client_success"].includes(dept.key)) throw new Error("sms_not_in_this_department");
  const access = await departmentMayUse(viewer.surface.tenantId, { kind: "connector", slug: "quo" }, dept.key);
  if (!access.allowed) throw new Error("quo_not_assigned_to_this_department");
  if (!payload.lead_id) {
    if (viewer.surface.persona !== "founder") throw new Error("sms_lead_required");
    return;
  }
  const lead = await openLead(viewer, payload.lead_id);
  if (!lead || lead === "no_scope") throw new Error("lead_not_found");
  const phone = normalizePhoneE164(typeof lead.data.phone === "string" ? lead.data.phone : "");
  if (!phone || phone !== payload.to) throw new Error("sms_recipient_does_not_match_lead");
}
