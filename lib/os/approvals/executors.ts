/**
 * lib/os/approvals/executors.ts — what each approved action_kind DOES, and only
 * through a send path this app already sanctions.
 *
 * THE REGISTRY IS THE WHOLE LIST. An action_kind with no entry here has no
 * executor, and approving it records a loud failure ("no executor for
 * send_sms") — never a success, never a silent no-op. A kind joins this list
 * only when it has a real, gated send path:
 *
 *   send_email    lib/integrations/oasis-shared-gmail-send.ts, the OASIS
 *                 mailbox: suppression check (fail-closed), brand-vs-mailbox
 *                 guard, OASIS footer, Message-Id from the idempotency key. It
 *                 is OASIS's mailbox, so the brand must resolve to "oasis" for
 *                 THIS tenant (lib/email/brand-for-tenant.ts, fail-closed); a
 *                 client workspace has no in-app sender yet and is told so.
 *                 Dry-run first: lib/integrations/send-mode.ts isDryRun("email")
 *                 (LIVE_SEND_EMAIL / DASHBOARD_LIVE_SEND / BRAVO_FORCE_DRY_RUN).
 *   publish_post  records INTENT in marketing_publish_intent, exactly as the
 *                 founders marketing Post panel does
 *                 (app/api/founders/marketing/assets/[id]/publish/route.ts):
 *                 the only thing that posts is marketing_publish_drain.py
 *                 behind send_gateway, and it posts to OASIS's OWN accounts.
 *                 So it is allowed only for a founders tenant
 *                 (FOUNDERS_TENANT_IDS) and only for an own-brand asset; every
 *                 check the panel's route makes is made here too. The intent
 *                 names the asset, not its words, so the approval binds the
 *                 asset's CONTENT (asset_hash, readPublishAsset below) and a
 *                 changed asset is refused; and the in-flight check and the
 *                 insert are one statement, so two approvals of one asset
 *                 cannot both queue.
 *   send_slack_message  chat.postMessage in the thread the @mention came from,
 *                 with the bot token of THIS workspace's live Slack connection
 *                 (lib/slack/send.ts). The approved team must be the
 *                 connection's own team, so an approval can never post into a
 *                 Slack workspace this tenant does not hold. Dry-run first:
 *                 isDryRun("slack") (LIVE_SEND_SLACK / DASHBOARD_LIVE_SEND /
 *                 BRAVO_FORCE_DRY_RUN). The posted reply is mirrored onto the
 *                 conversation (direction outbound).
 *
 * Dependencies are injected (ExecutorDeps) so tests drive the real executors
 * with a fake mailbox and a temp database; production passes nothing.
 */
import "server-only";
import type { Client, ResultSet } from "@libsql/client";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getTursoClient } from "@/lib/turso";
import { brandForTenant } from "@/lib/email/brand-for-tenant";
import type { BrandKey } from "@/lib/email/brands";
import type { EmailSigner } from "@/lib/config/email-signature";
import { resolveSignerForOperator } from "@/lib/config/agents";
import { isDryRun } from "@/lib/integrations/send-mode";
import { sendOasisSharedGmail, type OasisSharedSendResult } from "@/lib/integrations/oasis-shared-gmail-send";
import { checkEmailSuppressed } from "@/lib/lead-interactions-queries";
import { getServiceSupabase } from "@/lib/supabase-server";
import { publishAgentEvent, type AgentEventPublish } from "@/lib/manifest/events";
// The pure half of lib/founders/gate.ts: the same allowlist, without the
// session chain that module pulls in.
import { isFounderTenant, parseFoundersAllowlist, parseSlideUrls } from "@/lib/founders-marketing-core";
import { PUBLISH_CHANNELS, refusalFor } from "@/lib/founders/publish-targets";
import {
  ACTION_KIND_LABELS,
  publishAssetSnapshot,
  validatePublishPostPayload,
  validateSendEmailPayload,
  validateSendSlackMessagePayload,
  type ApprovalActionKind,
  type ExecutionResult,
} from "@/lib/os/approvals/rules";
import { payloadHashOf, type ApprovalRow } from "@/lib/os/approvals/store";
import { postSlackReply, type SlackPostArgs, type SlackPostOutcome } from "@/lib/slack/send";

export type ExecutorTenant = { id: string; slug: string | null };

export type SendEmailArgs = Parameters<typeof sendOasisSharedGmail>[0];

export type ExecutorDeps = {
  isDryRun: (channel?: string) => boolean;
  sendEmail: (args: SendEmailArgs) => Promise<OasisSharedSendResult>;
  /**
   * The opt-out lookup (email_suppressions), for the proposal's own Cc list.
   * The mailbox checks `to` itself; its Cc was only ever the team, so it
   * checks nothing else. Fail closed on checkFailed.
   */
  emailSuppression: (tenantId: string, email: string) => Promise<{ suppressed: boolean; checkFailed: boolean }>;
  /** The data plane the Post panel writes marketing_publish_intent through. */
  marketingDb: () => Pick<SupabaseClient, "from">;
  /**
   * The same database as SQL, for the one statement the query builder cannot
   * say: queue a publish only while none is in flight (INSERT ... WHERE NOT
   * EXISTS), atomically.
   */
  marketingSql: () => Client;
  foundersTenantIds: () => string[];
  signerFor: (email: string | null, brand: BrandKey) => EmailSigner | null;
  /** The Feed's event tape (agent_events). Best-effort: it logs, never throws. */
  publishEvent: (event: AgentEventPublish) => Promise<void>;
  /** Post a Slack reply for a tenant (lib/slack/send.ts). Absent = the real one. */
  postSlack?: (args: SlackPostArgs) => Promise<SlackPostOutcome>;
};

export function defaultExecutorDeps(): ExecutorDeps {
  return {
    isDryRun,
    sendEmail: sendOasisSharedGmail,
    emailSuppression: checkEmailSuppressed,
    marketingDb: () => getServiceSupabase(),
    marketingSql: () => {
      // getServiceSupabase().from() reads Turso only under turso_cloud; on any
      // other backend this SQL would write to a different database than the
      // Post panel reads, so it refuses (a recorded failure) instead.
      if (process.env.EMPIRE_DATA_BACKEND !== "turso_cloud") {
        throw new Error("the publish queue is not on Turso on this deployment, so nothing was queued");
      }
      return getTursoClient();
    },
    foundersTenantIds: () => parseFoundersAllowlist(process.env.FOUNDERS_TENANT_IDS),
    signerFor: (email, brand) => (email ? resolveSignerForOperator(email, { brand }) : null),
    publishEvent: publishAgentEvent,
  };
}

export type ExecutorContext = {
  db: Client;
  approval: ApprovalRow;
  payload: Record<string, unknown>;
  tenant: ExecutorTenant;
  /** The approver, from the session: signs the email and is copied on it. */
  approver: { userId: string; email: string | null } | null;
  deps: ExecutorDeps;
};

export type ExecutorOutcome =
  | { ok: true; result: Exclude<ExecutionResult, { outcome: "failed" }> }
  | { ok: false; result: Extract<ExecutionResult, { outcome: "failed" }> };

export type Executor = {
  /** Null when this workspace can carry the action out; otherwise the plain-English reason it cannot. */
  readiness: (tenant: ExecutorTenant, deps: ExecutorDeps) => string | null;
  run: (ctx: ExecutorContext) => Promise<ExecutorOutcome>;
};

function failed(reason: string, message: string, provider: string | null = null): ExecutorOutcome {
  return { ok: false, result: { outcome: "failed", reason, message, provider } };
}

// ---------------------------------------------------------------------------
// send_email
// ---------------------------------------------------------------------------

const EMAIL_PROVIDER = "oasis_shared_gmail";

function emailReadiness(tenant: ExecutorTenant): string | null {
  const brand = brandForTenant({ tenantId: tenant.id, tenantSlug: tenant.slug });
  if (!brand) return "This workspace has no email sender set up, so an approved email cannot go out from here.";
  if (brand !== "oasis") {
    return `This workspace sends as "${brand}", which has no sender inside the app; its email goes through the operator gateway.`;
  }
  return null;
}

/** What each OasisSharedSendResult reason means to the person who pressed Approve. */
export function emailFailureMessage(reason: string, error: string): string {
  switch (reason) {
    case "suppressed":
      return "The recipient has opted out of email, so nothing was sent.";
    case "suppression_error":
      return "The opt-out list could not be checked, so nothing was sent (it never guesses consent).";
    case "not_configured":
      return "The OASIS mailbox is not configured on this deployment, so nothing was sent.";
    case "brand_mismatch":
      return `The sending mailbox does not belong to this brand, so nothing was sent. ${error}`.trim();
    case "delivery_unknown":
      return "The mail server stopped answering mid-send. It may have gone out: check the Sent folder before approving it again.";
    case "send_failed":
      return `The mail server refused it: ${error}`;
    default:
      return error || reason;
  }
}

const sendEmail: Executor = {
  readiness: (tenant) => emailReadiness(tenant),
  async run(ctx) {
    const notReady = emailReadiness(ctx.tenant);
    if (notReady) return failed("no_sender", notReady);
    const v = validateSendEmailPayload(ctx.payload);
    if (!v.ok) return failed("payload_invalid", `The stored email is not valid (${v.error}).`);
    const { to, subject, body } = v.value;
    // The approver is copied, always: from a shared mailbox, nobody's own Sent
    // folder holds the message, and a person with no copy cannot tell a send
    // from a failure (oasis-shared-gmail-send.ts, the 2026-09-08 incident).
    const approverEmail = (ctx.approver?.email || "").trim().toLowerCase() || null;
    const cc = [...new Set([...(v.value.cc ?? []), ...(approverEmail ? [approverEmail] : [])])].filter((c) => c !== to);

    if (ctx.deps.isDryRun("email")) {
      return {
        ok: true,
        result: { outcome: "dry_run", provider: EMAIL_PROVIDER, would_send: { to, cc, subject } },
      };
    }

    // OPT-OUT GATE FOR THE PROPOSED COPIES. The mailbox checks `to` itself,
    // but a proposal's Cc is people outside the team too, and an address on
    // the opt-out list is not emailed because it rode in on a copy line.
    // Fail closed, like the mailbox: a lookup that errored is not consent.
    for (const addr of v.value.cc ?? []) {
      if (addr === approverEmail) continue;
      const supp = await ctx.deps.emailSuppression(ctx.tenant.id, addr);
      if (supp.checkFailed) {
        return failed("suppression_error", emailFailureMessage("suppression_error", ""), EMAIL_PROVIDER);
      }
      if (supp.suppressed) {
        return failed("suppressed", `${addr} (on the Cc line) has opted out of email, so nothing was sent.`, EMAIL_PROVIDER);
      }
    }

    const sent = await ctx.deps.sendEmail({
      tenantId: ctx.tenant.id,
      to,
      cc,
      subject,
      body,
      signer: ctx.deps.signerFor(approverEmail, "oasis"),
      idempotencyKey: ctx.approval.idempotency_key,
    });
    if (sent.ok) {
      return {
        ok: true,
        result: { outcome: "sent", provider: sent.provider, message_id: sent.gmail_message_id || null, from: sent.from_address },
      };
    }
    return failed(sent.reason, emailFailureMessage(sent.reason, sent.error), sent.provider);
  },
};

// ---------------------------------------------------------------------------
// publish_post
// ---------------------------------------------------------------------------

const PUBLISH_PROVIDER = "marketing_publish_intent";

function publishReadiness(tenant: ExecutorTenant, deps: ExecutorDeps): string | null {
  // The drainer posts to OASIS's own accounts. A row queued for any other
  // workspace would put that workspace's content on OASIS's channels.
  if (!isFounderTenant(tenant.id, deps.foundersTenantIds())) {
    return "The social publisher posts to OASIS's own accounts only, so a post from this workspace cannot be published from here.";
  }
  return null;
}

/**
 * The columns the checks below read, plus every column the publisher builds
 * the post from (rules.ts PUBLISH_ASSET_FIELDS).
 */
const PUBLISH_ASSET_COLUMNS = "id, title, status, brand_slug, format, asset_type, slide_count, media_urls, hook, body, cta, landing_url";

export type PublishAssetRead =
  | { ok: true; asset: Record<string, unknown> | null; media: Array<Record<string, unknown>>; assetHash: string | null }
  | { ok: false; reason: "read_failed" | "media_check_failed"; message: string };

/**
 * One asset (tenant-pinned) and its media rows as the publisher would post
 * them, with the sha256 a publish_post approval binds to (asset_hash). The
 * executor reads through this; anything that CREATES a publish_post approval
 * must read through it too and put `assetHash` in the payload.
 */
export async function readPublishAsset(
  db: Pick<SupabaseClient, "from">,
  tenantId: string,
  assetId: string,
): Promise<PublishAssetRead> {
  const asset = await db.from("marketing_asset").select(PUBLISH_ASSET_COLUMNS).eq("tenant_id", tenantId).eq("id", assetId).maybeSingle();
  if (asset.error) return { ok: false, reason: "read_failed", message: `The asset could not be read: ${asset.error.message}` };
  const row = asset.data as Record<string, unknown> | null;
  if (!row) return { ok: true, asset: null, media: [], assetHash: null };
  const media = await db.from("marketing_asset_media").select("kind, storage_bucket, storage_path").eq("tenant_id", tenantId).eq("asset_id", assetId);
  // Fail closed, like the route: a check that could not run is not a pass.
  if (media.error) return { ok: false, reason: "media_check_failed", message: `Could not confirm the asset has media: ${media.error.message}` };
  const files = (media.data || []) as Array<Record<string, unknown>>;
  return { ok: true, asset: row, media: files, assetHash: payloadHashOf(publishAssetSnapshot(row, files)) };
}

const publishPost: Executor = {
  readiness: publishReadiness,
  async run(ctx) {
    const notReady = publishReadiness(ctx.tenant, ctx.deps);
    if (notReady) return failed("no_publisher", notReady);
    const v = validatePublishPostPayload(ctx.payload);
    if (!v.ok) return failed("payload_invalid", `The stored post is not valid (${v.error}).`);
    const { asset_id, asset_hash, platforms, note } = v.value;
    const tenantId = ctx.tenant.id;

    // Tenant-scoped, own brand only — the Post panel's rule.
    const read = await readPublishAsset(ctx.deps.marketingDb(), tenantId, asset_id);
    if (!read.ok) return failed(read.reason, read.message, PUBLISH_PROVIDER);
    const a = read.asset as
      | { id: string; title: string | null; brand_slug: string | null; asset_type: string | null; slide_count: number | null; media_urls: unknown }
      | null;
    if (!a) return failed("asset_not_found", "That asset does not exist in this workspace.", PUBLISH_PROVIDER);
    if (a.brand_slug !== "oasis-ai") {
      return failed("asset_not_own_brand", "Only OASIS's own content can be published from here.", PUBLISH_PROVIDER);
    }

    if (a.asset_type === "carousel") {
      const slideCount = parseSlideUrls(a.media_urls).length || Number(a.slide_count || 0);
      const refused = platforms
        .map((p) => {
          const channel = PUBLISH_CHANNELS.find((c) => c.id === p);
          return channel ? refusalFor(channel, "images", slideCount) : null;
        })
        .filter((why): why is string => Boolean(why));
      if (refused.length) return failed("platform_media_limit", refused.join("; "), PUBLISH_PROVIDER);
    }

    if (read.media.length === 0) return failed("no_media_attached", "The asset has no media attached, so every channel would refuse it.", PUBLISH_PROVIDER);

    // What was approved is what posts. The intent carries only the asset id
    // and the drainer reads the asset when it runs, so an asset edited after
    // the "yes" (a new caption, other slides, a swapped video) is refused here.
    if (read.assetHash !== asset_hash) {
      return failed(
        "asset_changed",
        "The post changed after it was approved (its caption, title, slides or media), so it was not queued. Ask for a new approval.",
        PUBLISH_PROVIDER,
      );
    }

    // ONE statement: queue it only while nothing for this asset is queued or
    // running. A read-then-insert let two approvals of the same asset both see
    // "nothing in flight" and both queue, and there is no unsending.
    let queued: ResultSet;
    try {
      queued = await ctx.deps.marketingSql().execute({
        sql: `INSERT INTO marketing_publish_intent (tenant_id, asset_id, platforms, requested_by, note, state)
              SELECT ?, ?, ?, ?, ?, 'queued'
              WHERE NOT EXISTS (SELECT 1 FROM marketing_publish_intent
                                WHERE tenant_id = ? AND asset_id = ? AND state IN ('queued', 'running'))
              RETURNING id`,
        args: [
          tenantId,
          asset_id,
          JSON.stringify(platforms),
          // Provenance: the approval row names who approved it and when.
          `approval:${ctx.approval.id}`,
          note ?? null,
          tenantId,
          asset_id,
        ],
      });
    } catch (err) {
      return failed("queue_failed", `The publish could not be queued: ${err instanceof Error ? err.message : String(err)}`, PUBLISH_PROVIDER);
    }
    // The RETURNING row is the proof it was queued (a local libSQL file reports
    // rowsAffected 0 for a statement with RETURNING, so that is not read).
    if (queued.rows.length !== 1) {
      return failed("already_queued", "A publish for this asset is already in flight; there is no unsending, so this one was not queued.", PUBLISH_PROVIDER);
    }
    return {
      ok: true,
      result: { outcome: "queued", provider: PUBLISH_PROVIDER, intent_id: String(queued.rows[0].id), platforms },
    };
  },
};

// ---------------------------------------------------------------------------
// send_slack_message
// ---------------------------------------------------------------------------

const SLACK_PROVIDER = "slack";

const sendSlackMessage: Executor = {
  // Whether the workspace holds a live Slack connection is read when it runs
  // (a database read); the card says "Slack reply" and the outcome says what
  // happened, never a success it did not have.
  readiness: () => null,
  async run(ctx) {
    const v = validateSendSlackMessagePayload(ctx.payload);
    if (!v.ok) return failed("payload_invalid", `The stored Slack reply is not valid (${v.error}).`);
    const { team_id, channel_id, thread_ts, text } = v.value;
    if (ctx.deps.isDryRun("slack")) {
      return {
        ok: true,
        result: { outcome: "dry_run", provider: SLACK_PROVIDER, would_send: { channel: channel_id, thread_ts, characters: text.length } },
      };
    }
    const post = ctx.deps.postSlack ?? ((args: SlackPostArgs) => postSlackReply(ctx.db, args));
    const sent = await post({
      tenantId: ctx.tenant.id,
      teamId: team_id,
      channelId: channel_id,
      threadTs: thread_ts,
      text,
      department: v.value.department ?? ctx.approval.department_key ?? null,
      approvalId: ctx.approval.id,
    });
    if (sent.ok) return { ok: true, result: { outcome: "sent", provider: SLACK_PROVIDER, message_id: sent.ts } };
    return failed(sent.reason, sent.message, SLACK_PROVIDER);
  },
};

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

export const EXECUTORS: Readonly<Partial<Record<ApprovalActionKind, Executor>>> = {
  send_email: sendEmail,
  publish_post: publishPost,
  send_slack_message: sendSlackMessage,
};

export function noExecutorMessage(kind: string): string {
  const label = ACTION_KIND_LABELS[kind as ApprovalActionKind] ?? kind;
  return `no executor for ${kind}: nothing in this app can carry out a ${label.toLowerCase()} yet, so it was not done.`;
}

/**
 * Can this workspace carry out this kind of action? Shown on the card BEFORE
 * anyone approves, so "approve" is never pressed in the belief that it will do
 * something it cannot.
 */
export function executorReadiness(
  kind: ApprovalActionKind,
  tenant: ExecutorTenant,
  deps: ExecutorDeps,
): { executable: boolean; note: string | null } {
  const executor = EXECUTORS[kind];
  if (!executor) return { executable: false, note: `Nothing in this app can carry out a ${(ACTION_KIND_LABELS[kind] ?? kind).toLowerCase()} yet. Approving records that it was not done.` };
  const note = executor.readiness(tenant, deps);
  return note ? { executable: false, note } : { executable: true, note: null };
}
