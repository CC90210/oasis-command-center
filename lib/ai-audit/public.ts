/**
 * lib/ai-audit/public.ts — what the client's private page and its endpoints
 * read, from nothing but the link token.
 *
 * One answer for every kind of "no" (missing, expired, revoked, a version that
 * is no longer readable): null. The page then shows the same neutral message,
 * so a link reveals nothing about which of those it was.
 */
import "server-only";
import type { Client } from "@libsql/client";
import { clientIpFromHeaders } from "@/lib/api-helpers";
import { sameOrigin } from "@/lib/offer-pages/public-http";
import { rateLimit } from "@/lib/rate-limit";
import { findLiveLink, type ShareLink } from "@/lib/ai-audit/link";
import { getAuditVersion, getProposalVersion, type AuditVersion, type ProposalVersion } from "@/lib/ai-audit/versions";
import { getEngagement, type Engagement } from "@/lib/ai-audit/store";
import { proposalTotals, type ProposalTotals } from "@/lib/ai-audit/proposal";

export type PublicAudit = {
  link: ShareLink;
  engagement: Engagement;
  audit: AuditVersion & { doc: NonNullable<AuditVersion["doc"]> };
  proposal: ProposalVersion & { content: NonNullable<ProposalVersion["content"]> };
  totals: ProposalTotals;
};

export async function loadPublicAudit(db: Client, token: unknown, now: Date): Promise<PublicAudit | null> {
  const link = await findLiveLink(db, token, now);
  if (!link) return null;
  const [engagement, audit, proposal] = await Promise.all([
    getEngagement(db, link.tenant_id, link.engagement_id),
    getAuditVersion(db, link.tenant_id, link.audit_version_id),
    getProposalVersion(db, link.tenant_id, link.proposal_version_id),
  ]);
  if (!engagement || !audit?.doc || !proposal?.content) return null;
  // Only what CC approved and delivered (a later revision supersedes it, still readable on its own link until replaced).
  if (!["delivered", "superseded"].includes(audit.status) || !["delivered", "superseded"].includes(proposal.status)) return null;
  return {
    link,
    engagement,
    audit: audit as PublicAudit["audit"],
    proposal: proposal as PublicAudit["proposal"],
    totals: proposalTotals(proposal.content),
  };
}

/** Why the Pay button is not shown, in the client's words, or null when it is. */
export function payUnavailableReason(p: PublicAudit, now: Date): string | null {
  if (p.engagement.payment_status === "paid" || p.engagement.payment_status === "overpaid_review") {
    return "Thank you: your payment is confirmed. We will be in touch about next steps.";
  }
  if (p.engagement.stage === "declined" || p.engagement.stage === "cancelled") return "This proposal is no longer open. Reply to our email if you would like to talk.";
  // Being revised (phase 5): the client reads what they have, and pays the new version once it is sent.
  if (p.engagement.stage === "generating" || p.engagement.stage === "final_review") return "We are updating this proposal. The new version will reach you by email, and you can pay from there.";
  if (p.proposal.status !== "delivered") return "This proposal has been replaced by a newer one. Check your email for the latest link.";
  if (p.proposal.content.valid_until < now.toISOString().slice(0, 10)) return "This proposal's offer period has ended. Reply to our email and we will send an updated one.";
  return null;
}

/**
 * Is this POST (Pay, or the view beacon) from the client's own audit page? The
 * Origin (or Referer) must name this host. A browser that still sends
 * `Origin: null` (a stricter referrer setting of its own) is accepted only
 * when it also says `Sec-Fetch-Site: same-origin`, a header pages cannot set.
 * Before PR #732's review both routes used the plain check under a
 * no-referrer page, and every real browser was refused.
 */
export function fromOwnAuditPage(req: Request): boolean {
  if (sameOrigin(req)) return true;
  return req.headers.get("origin") === "null" && req.headers.get("sec-fetch-site") === "same-origin";
}

/** 20 requests, refilling one every three seconds, per address and route. */
export function publicLimited(req: Request, route: string): boolean {
  const resolved = clientIpFromHeaders(req.headers);
  const ip = resolved === "unknown" ? "no-ip" : resolved;
  return !rateLimit({ key: `your-audit:${route}:${ip}`, capacity: 20, refillPerSec: 1 / 3 }).allowed;
}

export const PUBLIC_NOT_FOUND = { ok: false, error: "not_found" } as const;
