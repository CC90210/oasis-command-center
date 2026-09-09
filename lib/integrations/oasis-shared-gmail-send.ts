/**
 * lib/integrations/oasis-shared-gmail-send.ts — send an OASIS rep's email from
 * ONE shared mailbox, with the rep CC'd.
 *
 * WHY THIS SHAPE (CC, 2026-09-08): "use my app password, then just CC/forward
 * the reps with their emails, and make this as easy as possible." One mailbox
 * for the whole team, not a Gmail connection per rep. A rep never has to set
 * anything up, and a new rep works on day one.
 *
 * WHAT IT REPLACES. Every OASIS rep email was going out through the bridge to
 * send_gateway on CC's own machine. That path is brand-correct and it works,
 * but it is only alive while that machine is. Five emails have sat queued since
 * 2026-08-20 because of it, and a rep sending into that silence cannot tell a
 * slow send from a dead one. This path runs from Vercel and does not care
 * whether any particular computer is switched on.
 *
 * THE REP IS CC'd, ALWAYS. Sending from a shared mailbox means the message
 * lands in nobody's personal Sent folder, so without the CC a rep has no copy
 * anywhere and a successful send is indistinguishable from a failure. That is
 * exactly what happened on 2026-09-08: a send the ledger recorded as delivered
 * was reported as never sent, and the rep pressed the button again.
 *
 * OASIS FOOTER, NOT THE DEFAULT. appendSignatureAndFooter defaults to SunBiz's
 * legal footer, which is correct for that portal and false on an OASIS lead
 * (wrong company, wrong country, and it tells a cold prospect they submitted a
 * funding inquiry). `brand: "oasis"` is not optional here.
 *
 * NEVER THROWS. Returns a typed result so the route can fall back to the bridge
 * exactly as it does today. Until the credential is stored this returns
 * `not_configured` on every call and the existing path carries on unchanged.
 */

import "server-only";
import { getTenantIntegrationBundle } from "@/lib/tenant-integration-store";
import { checkEmailSuppressed } from "@/lib/lead-interactions-queries";
import { appendSignatureAndFooter, type EmailSigner } from "@/lib/config/email-signature";
import { finalizeCopyList } from "@/lib/leads/lead-copy-recipients";
import { mailboxBrandConflict } from "@/lib/email/brand-for-tenant";

/**
 * `tenant_integration_credentials.service` holding the shared OASIS mailbox.
 *
 * Deliberately NOT "gws". That service key is the Google Workspace row the
 * integrations settings page already manages for Calendar/Drive/Docs, and
 * overloading it would mean a rep rotating a Calendar credential silently
 * changes who outbound sales email comes from. A separate key keeps the two
 * decisions separate.
 */
export const OASIS_MAIL_SERVICE = "oasis_gmail";

export type OasisSharedSendResult =
  | { ok: true; provider: "oasis_shared_gmail"; gmail_message_id: string; from_address: string }
  | {
      ok: false;
      provider: "oasis_shared_gmail";
      reason: "not_configured" | "send_failed" | "suppressed" | "suppression_error";
      error: string;
    };

/** True when the shared OASIS mailbox is configured, by env or by tenant row. */
export async function oasisSharedMailboxConfigured(tenantId: string): Promise<boolean> {
  return !!(await resolveOasisMailboxFrom(tenantId));
}

/**
 * The address OASIS mail leaves from, or null.
 *
 * Exported so CALLERS can exclude it from a Cc list. The shared sender already
 * filters its own From, but the bridge fallback sends from the same mailbox
 * without that knowledge — so a send that fell through to the bridge could
 * still copy the sending address onto its own message, which is the exact
 * duplication this work removes. Resolving it once in the route closes every
 * transport at the same point.
 */
export async function resolveOasisMailboxFrom(tenantId: string): Promise<string | null> {
  const envFrom = (process.env.OASIS_MAIL_FROM || "").trim();
  if (envFrom && (process.env.OASIS_MAIL_APP_PASSWORD || "").trim()) return envFrom;
  if (!tenantId) return null;
  const b = await getTenantIntegrationBundle(tenantId, OASIS_MAIL_SERVICE).catch(
    () => ({}) as Record<string, string>,
  );
  const from = (b.from_address || "").trim();
  return from && (b.app_password || "").trim() ? from : null;
}

/**
 * The exact message object handed to nodemailer.
 *
 * SEPARATED SO IT CAN BE PROVEN. Everything CC reported was wrong lives in these
 * headers, and every previous test of this feature asserted on source text
 * rather than on a composed message — which is how From/Cc/Reply-To all being
 * one address survived review. The send path needs a database (suppression) and
 * a credential, so nothing downstream of it could ever be exercised in a unit
 * test; this can, with no stubbing at all.
 *
 * PURE. Same inputs, same message, no I/O.
 */
export function composeOasisMessage(args: {
  to: string;
  cc?: string | string[] | null;
  replyTo?: string | null;
  subject: string;
  body: string;
  html?: string | null;
  signer?: EmailSigner | null;
  fromAddress: string;
}): {
  from: string;
  to: string;
  cc?: string;
  replyTo?: string;
  subject: string;
  headers: Record<string, string>;
  text: string;
  html?: string;
} {
  const { fromAddress } = args;

  // Never copy the recipient, and never copy THIS MAILBOX. Sending from the
  // shared address and Cc'ing it puts a duplicate beside the copy already in its
  // own Sent folder — the header CC saw on 2026-09-09 read From, Cc and Reply-To
  // all conaugh@oasisai.work.
  const ccList = finalizeCopyList(args.cc, { to: args.to, fromAddress });
  const excluded = new Set([args.to.trim().toLowerCase(), fromAddress.toLowerCase()]);

  // Replies go to the person who OWNS the lead, not to the shared mailbox —
  // otherwise the prospect answers into an inbox nobody watches, which is the
  // same invisibility the Cc exists to fix, one step later in the conversation.
  const replyToCandidate = (args.replyTo || "").trim();
  const replyTo =
    replyToCandidate && !excluded.has(replyToCandidate.toLowerCase())
      ? replyToCandidate
      : ccList[0];

  return {
    from: fromAddress,
    to: args.to,
    ...(ccList.length ? { cc: ccList.join(", ") } : {}),
    ...(replyTo ? { replyTo } : {}),
    subject: args.subject,
    // The opt-out is "reply UNSUBSCRIBE", stated in both parts. Declaring it as
    // a header too lets a mail client offer its own one-click control and keeps
    // filters from treating a branded HTML message as unattributed bulk. It
    // points at the mailbox that is actually read, and matches the instruction
    // in the footer rather than inventing a second mechanism.
    headers: { "List-Unsubscribe": `<mailto:${fromAddress}?subject=UNSUBSCRIBE>` },
    // PLAIN TEXT STAYS THE SOURCE OF TRUTH. appendSignatureAndFooter is a
    // plain-text helper — it joins with "\n\n---\n" and detects an existing
    // signature by comparing the last LINE — so it is applied here and never to
    // the markup, which carries its own. Sending both parts means a client that
    // refuses HTML still gets the whole message rather than a blank.
    text: appendSignatureAndFooter(args.body, {
      signer: args.signer,
      fromAddress,
      brand: "oasis",
    }),
    ...(args.html ? { html: args.html } : {}),
  };
}

export async function sendOasisSharedGmail(args: {
  tenantId: string;
  to: string;
  /**
   * Who to copy: the lead's assigned rep first, then the sender. Accepts a
   * single address for older callers. Anything equal to `to` or to this
   * mailbox's own From address is dropped below — this is the only layer that
   * knows the From address, and copying it produced the redundant
   * From/Cc/Reply-To-all-one-address header CC reported on 2026-09-09.
   */
  cc?: string | string[] | null;
  /** Where replies go. Defaults to the first copy recipient. */
  replyTo?: string | null;
  subject: string;
  body: string;
  /**
   * Branded HTML alternative. `body` remains the plain-text part, so both are
   * sent (multipart/alternative) and a client that refuses HTML still gets a
   * readable message. Must already carry its own signature and footer:
   * appendSignatureAndFooter is plain-text only and is applied to `body` alone.
   */
  html?: string | null;
  /** The acting rep, so the sign-off is theirs and not the mailbox owner's. */
  signer?: EmailSigner | null;
}): Promise<OasisSharedSendResult> {
  // OPT-OUT GATE FIRST, before any credential work or send. Fail closed: a
  // suppression lookup that errors must not be read as "not suppressed".
  // checkEmailSuppressed CATCHES ITS OWN ERRORS and returns
  // { suppressed: false, checkFailed: true } rather than throwing
  // (lib/lead-interactions-queries.ts:144-147). So a try/catch around it is
  // dead code, and reading only `.suppressed` treats a FAILED LOOKUP as
  // "not suppressed" and emails someone who may have opted out. `checkFailed`
  // is the whole point of the return shape and has to be read.
  let supp: { suppressed: boolean; checkFailed: boolean };
  try {
    supp = await checkEmailSuppressed(args.tenantId, args.to);
  } catch (e) {
    // Belt and braces: it does not throw today, but a future rewrite that does
    // must not silently become a fail-open.
    return {
      ok: false,
      provider: "oasis_shared_gmail",
      reason: "suppression_error",
      error: e instanceof Error ? e.message.slice(0, 200) : "suppression_check_failed",
    };
  }
  if (supp.checkFailed) {
    return {
      ok: false,
      provider: "oasis_shared_gmail",
      reason: "suppression_error",
      error: "suppression lookup failed; refusing to send rather than assume consent",
    };
  }
  if (supp.suppressed) {
    return {
      ok: false,
      provider: "oasis_shared_gmail",
      reason: "suppressed",
      error: "recipient in email_suppressions",
    };
  }

  // CREDENTIAL SOURCE: Vercel env FIRST, tenant row second.
  //
  // The repo's own security posture puts deployment secrets in Vercel env, and
  // a review of the first cut of this feature flagged the alternative — a local
  // file feeding a provisioning script — as the wrong path. Env also removes a
  // sharp edge that has no upside here: a tenant row is encrypted at rest with
  // BRAVO_FIELD_ENCRYPTION_KEY, so a row written under any other key stores
  // successfully and is undecryptable in production, silently, with sends just
  // falling back to the bridge and nobody learning why.
  //
  // The tenant row is kept as the second source because it is PER-TENANT, and
  // env is not. Today OASIS is one workspace with one sending mailbox; the day
  // a second one needs its own address, it sets a row and that row wins for it
  // without disturbing this one.
  const envFrom = (process.env.OASIS_MAIL_FROM || "").trim();
  const envPassword = (process.env.OASIS_MAIL_APP_PASSWORD || "").trim();
  const bundle =
    envFrom && envPassword
      ? ({ from_address: envFrom, app_password: envPassword } as Record<string, string>)
      : await getTenantIntegrationBundle(args.tenantId, OASIS_MAIL_SERVICE).catch(
          () => ({}) as Record<string, string>,
        );
  const fromAddress = (bundle.from_address || "").trim();
  // Strip ALL whitespace, not just the ends. Google displays an app password as
  // four spaced groups, and a value pasted that way is 19 characters for a
  // 16-character secret — which authenticates against IMAP in some clients and
  // returns 535 on SMTP, so the channel looks half-alive and the failure reads
  // as a wrong password when it is really a formatting one. The SunBiz path
  // learned this on 2026-07-02; inherited here rather than re-learned.
  const appPassword = (bundle.app_password || "").replace(/\s+/g, "");
  if (!fromAddress || !appPassword) {
    return {
      ok: false,
      provider: "oasis_shared_gmail",
      reason: "not_configured",
      error: `no ${OASIS_MAIL_SERVICE} from_address/app_password for this tenant`,
    };
  }

  // THE MAILBOX MUST BE ENTITLED TO THE BRAND.
  //
  // composeOasisMessage stamps `brand: "oasis"` into the footer as a literal,
  // and the transport below authenticates as `fromAddress` — which comes from
  // an env var. Nothing connected the two. Point OASIS_MAIL_FROM at
  // submissions@sunbizfunding.com and this function would have sent
  // OASIS-branded mail authenticated as the client's mailbox, landing in a Sent
  // folder they read. That is the 2026-09-09 incident exactly, and the Python
  // chokepoint got a guard for it while this path went without one.
  const mismatch = mailboxBrandConflict("oasis", fromAddress);
  if (mismatch) {
    return {
      ok: false,
      provider: "oasis_shared_gmail",
      reason: "send_failed",
      error: `refusing to send: ${mismatch}. A mailbox may not assert another company's identity.`,
    };
  }

  const message = composeOasisMessage({ ...args, fromAddress });

  try {
    const nodemailer = await import("nodemailer");
    const transporter = nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 587,
      secure: false,
      auth: { user: fromAddress, pass: appPassword },
      // EXPLICIT TIMEOUTS, well inside the route's 60s maxDuration.
      //
      // Nodemailer defaults to a 120s connection timeout and a 600s socket
      // timeout. This call runs BEFORE the bridge fallback, so on a hung SMTP
      // the defaults would keep sendMail pending until Vercel terminated the
      // whole request: the fallback never runs, the rep gets no answer, and the
      // "immediate send, else bridge" contract is quietly lost. Failing fast
      // here is what keeps the fallback reachable.
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    });
    const info = await transporter.sendMail(message);
    return {
      ok: true,
      provider: "oasis_shared_gmail",
      gmail_message_id: info.messageId || "",
      from_address: fromAddress,
    };
  } catch (e) {
    return {
      ok: false,
      provider: "oasis_shared_gmail",
      reason: "send_failed",
      // First line only: SMTP errors carry multi-line server chatter and the
      // useful part is the code. Truncated so a credential can never ride out
      // in an error string.
      error: e instanceof Error ? e.message.split("\n")[0].slice(0, 200) : "smtp_error",
    };
  }
}
