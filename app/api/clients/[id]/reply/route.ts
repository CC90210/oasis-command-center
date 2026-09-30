/**
 * POST /api/clients/[id]/reply — write to a client from their record.
 *
 * Body: { to?, subject, body, confirmed, channel?: "email" }
 *
 *   A person's message   sent only with confirmed: true (the composer asks
 *                        "Send this email to <address>?" first), through the
 *                        workspace's OWN mailbox: OASIS's workspace sends from
 *                        the OASIS mailbox; any other workspace only from the
 *                        teammate's own mailbox connected in it, never from
 *                        OASIS's (lib/os/customers/conversations.ts
 *                        resolveClientMailbox). A workspace with no registered
 *                        sender identity, or no mailbox: a 409 that says which,
 *                        and nothing is sent. Sent: it is written to the
 *                        message ledger and the client's thread, so it shows
 *                        in the record's Conversations.
 *   An agent's draft     NOT taken here (403): a session is a person. The agent
 *                        runtime proposes it itself (proposeClientEmail), as
 *                        ONE send_email approval decided in Feed.
 *
 * Who: the workspace's desk team (owners and admins who may act), the same
 * people who read the client's messages. The client and the workspace come
 * from the session and the path; a tenant in the body is ignored. The client
 * must be one of THIS workspace's (404 otherwise), and the address one of the
 * client's own.
 *
 * The hard kill switch (BRAVO_FORCE_DRY_RUN=1) answers "dry run: nothing was
 * sent" after every check has passed.
 */
import { NextResponse, type NextRequest } from "next/server";
import { resolveSessionContext } from "@/lib/api-auth";
import { resolveSignerForOperator } from "@/lib/config/agents";
import { DELIVERY_TENANT_ID } from "@/lib/delivery/rules";
import { brandForTenant } from "@/lib/email/brand-for-tenant";
import type { EmailSigner } from "@/lib/config/email-signature";
import { operatorHasAppPassword, sendGmailAppPasswordAsOperator } from "@/lib/integrations/gmail-apppassword-send";
import { operatorHasGmailOAuth, sendGmailAsOperator } from "@/lib/integrations/gmail-oauth-send";
import { resolveOasisMailboxFrom, sendOasisSharedGmail } from "@/lib/integrations/oasis-shared-gmail-send";
import { getTenant } from "@/lib/queries";
import {
  clientAddresses,
  sendClientEmail,
  validateClientReply,
  type MailboxDeps,
} from "@/lib/os/customers/conversations";
import { getCustomer, listContacts } from "@/lib/os/customers/store";
import {
  customersError,
  customersServerError,
  getCustomersDb,
  readJsonBody,
  resolveClientsViewer,
} from "@/lib/os/customers/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Params = { params: Promise<{ id: string }> };

/** The real mailboxes. Tests drive sendClientEmail with fakes instead. */
function defaultMailboxDeps(): MailboxDeps {
  return {
    oasisTenantId: DELIVERY_TENANT_ID,
    killSwitch: () => (process.env.BRAVO_FORCE_DRY_RUN || "").trim() === "1",
    oasisMailboxFrom: resolveOasisMailboxFrom,
    sendOasis: (a) =>
      sendOasisSharedGmail({
        tenantId: a.tenantId,
        to: a.to,
        cc: a.cc,
        subject: a.subject,
        body: a.body,
        signer: (a.signer as EmailSigner | null) ?? null,
        idempotencyKey: a.idempotencyKey,
      }),
    operatorMailbox: async (tenantId, userId) =>
      (await operatorHasAppPassword(tenantId, userId)) ? "app_password" : (await operatorHasGmailOAuth(tenantId, userId)) ? "oauth" : null,
    sendAsOperator: (kind, a) => {
      const args = {
        tenantId: a.tenantId,
        userId: a.userId,
        to: a.to,
        subject: a.subject,
        body: a.body,
        brand: a.brand,
        idempotencyKey: a.idempotencyKey,
        signer: (a.signer as EmailSigner | null) ?? null,
      };
      return kind === "app_password" ? sendGmailAppPasswordAsOperator(args) : sendGmailAsOperator(args);
    },
    brandFor: async (tenantId) => {
      const tenant = await getTenant(tenantId);
      return brandForTenant({ tenantId, tenantSlug: tenant?.slug ?? "" });
    },
    signerFor: (email, brand) => (email ? resolveSignerForOperator(email, { brand }) : null),
  };
}

export async function POST(req: NextRequest, { params }: Params) {
  try {
    const { id } = await params;
    const viewer = await resolveClientsViewer();
    if (!viewer) return customersError(401, "not_signed_in");
    if (!viewer.desk || !viewer.desk.canAct) return customersError(403, "forbidden");
    const db = getCustomersDb();
    if (!db) return customersError(503, "database_not_configured");
    const customer = await getCustomer(db, viewer.tenantId, id);
    if (!customer) return customersError(404, "not_found");
    const parsed = await readJsonBody(req);
    if (!parsed.ok) return customersError(400, "invalid_json");
    const contacts = await listContacts(db, viewer.tenantId, customer.id);
    const v = validateClientReply(parsed.body, clientAddresses(customer, contacts));
    if (!v.ok) return customersError(400, v.error, { field: v.field });
    const now = new Date();

    // A person's session never files a draft AS an agent: an agent's draft is
    // proposed by the agent runtime itself (proposeClientEmail, with the
    // agent's own key). Nothing is created here.
    if (v.value.draftedBy === "agent") return customersError(403, "agent_drafts_not_from_a_session");

    const session = await resolveSessionContext();
    const userEmail = session.ok ? session.email || null : null;
    const result = await sendClientEmail(db, defaultMailboxDeps(), {
      tenantId: viewer.tenantId,
      userId: viewer.userId,
      userEmail,
      customer,
      reply: v.value,
      now,
    });
    if (!result.ok) return customersError(result.status, result.error, result.message ? { message: result.message } : undefined);
    if (result.status === "dry_run") {
      return NextResponse.json({
        ok: true,
        status: "dry_run",
        would_send: result.wouldSend,
        message: `Dry run: nothing was sent. It would have gone to ${result.wouldSend.to} from ${result.wouldSend.mailbox}.`,
      });
    }
    if (result.status === "delivery_unknown") {
      return NextResponse.json({ ok: true, status: "delivery_unknown", interaction_id: result.interactionId, message: result.message });
    }
    return NextResponse.json({
      ok: true,
      status: "sent",
      interaction_id: result.interactionId,
      from: result.from,
      tracking_warning: result.trackingWarning,
      message: result.trackingWarning ?? `Sent to ${v.value.to}.`,
    });
  } catch (err) {
    return customersServerError("client_reply", err);
  }
}
