/**
 * Where an approval card stands, in words, for the engagement page: Gate 1 on
 * the Call tab, Gate 2 and the welcome email on the Delivery tab. The card
 * itself says the same in components/os/approvals/outcome.ts. An executed card
 * says what its run recorded, so a test run never reads as sent.
 */
const STATUS_WORDS: Record<string, string> = {
  pending: "waiting for you in Needs you",
  approved: "approved, being carried out",
  executing: "being carried out",
  failed: "failed",
  sent_back: "sent back",
  expired: "expired before anyone decided",
  cancelled: "withdrawn: a newer card replaced it",
  voided: "no longer holds",
};

const OUTCOME_WORDS: Record<string, string> = {
  dry_run: "approved as a test run: nothing was sent",
  sent: "approved and sent",
  authorized: "authorized",
};

export function approvalStatusWords(a: { status: string; outcome: string | null }): string {
  if (a.status === "executed") return (a.outcome && OUTCOME_WORDS[a.outcome]) || "carried out";
  return STATUS_WORDS[a.status] ?? a.status.replace(/_/g, " ");
}
