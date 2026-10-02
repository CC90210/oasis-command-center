/**
 * ClientRecordCard — the "Convert to client" step on a WON deal.
 *
 *   <ClientRecordCard tenantId={tenantId} leadId={id} stage={stageKey} />
 *
 * Rendered on the deal pages (the OASIS pipeline's /pipeline/[id] and a
 * workspace's manifest lead record) without changing anything else on them:
 * nothing is drawn unless the deal is in a won stage
 * (lib/os/customers/rules.ts CONVERTIBLE_LEAD_STAGES) AND the viewer may see
 * client identities in the workspace the deal belongs to. Then it says one of:
 *   - "Client record: <name>" with a link, when the deal already is one;
 *   - "Convert to client" (owners and admins), which creates the record linked
 *     by source_lead_id — idempotent, see /api/customers/convert;
 *   - that client records are not set up yet, or could not be checked.
 *
 * The tenant must be the SESSION's: a page that renders a deal from another
 * workspace (an operator preview) gets no card rather than a wrong answer.
 */
import "server-only";

import Link from "next/link";
import { ConvertToClientButton } from "@/components/os/landings/clients-actions";
import { isConvertibleLeadStage } from "@/lib/os/customers/rules";
import { getCustomerBySourceLead, isMissingCustomersSchema, type Customer } from "@/lib/os/customers/store";
import { getCustomersDb, resolveClientsViewer } from "@/lib/os/customers/session";
import { CUSTOMER_LIFECYCLE_LABELS } from "@/lib/os/customers/rules";

type Found = { state: "record"; customer: Customer } | { state: "none" } | { state: "not_set_up" } | { state: "error" };

export async function ClientRecordCard({
  tenantId,
  leadId,
  stage,
}: {
  tenantId: string;
  leadId: string;
  stage: string | null | undefined;
}) {
  if (!isConvertibleLeadStage(stage)) return null;
  const viewer = await resolveClientsViewer();
  if (!viewer || !viewer.canRead || viewer.tenantId !== tenantId) return null;
  const db = getCustomersDb();
  let found: Found;
  if (!db) {
    console.error("[os.clients.record_card] Turso is not configured on this deployment");
    found = { state: "error" };
  } else {
    try {
      const customer = await getCustomerBySourceLead(db, viewer.tenantId, leadId);
      found = customer ? { state: "record", customer } : { state: "none" };
    } catch (err) {
      if (isMissingCustomersSchema(err)) {
        // The card says only that client records aren't available; the reason is here.
        console.error("[os.clients.record_card] client records are not set up: the customers table is missing", err);
        found = { state: "not_set_up" };
      } else {
        console.error("[os.clients.record_card]", err);
        found = { state: "error" };
      }
    }
  }

  return (
    <section className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-hairline bg-bg-panel px-4 py-3">
      <div className="min-w-0">
        <h2 className="text-sm font-semibold text-fg">Client record</h2>
        <p className="mt-0.5 text-[13px] text-fg-muted">
          {found.state === "record"
            ? `${found.customer.display_name} · ${CUSTOMER_LIFECYCLE_LABELS[found.customer.lifecycle]}`
            : found.state === "none"
              ? "This deal is won. As a client it carries its tickets, projects, files and activity in one place."
              : found.state === "not_set_up"
                ? "Client records aren't available right now. The error has been logged."
                : "Couldn't check for a client record. The error has been logged."}
        </p>
      </div>
      {found.state === "record" ? (
        <Link href={`/clients/${found.customer.id}`} prefetch={false} className="btn-secondary">
          Open client
        </Link>
      ) : found.state === "none" ? (
        viewer.canWrite ? (
          <ConvertToClientButton leadId={leadId} />
        ) : (
          <span className="text-[13px] text-fg-dim">An owner or admin can convert it.</span>
        )
      ) : null}
    </section>
  );
}
