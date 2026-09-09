/**
 * lead-copy-recipients.ts — who gets copied on a lead email.
 *
 * THE DEFECT THIS EXISTS TO FIX (reported by CC, 2026-09-09). The route CC'd
 * `sess.email` — whoever pressed the button — and nothing else. Two consequences,
 * both live:
 *
 *   1. THE REP WHO OWNS THE LEAD WAS NEVER COPIED. Broadway Locksmith is
 *      assigned to schneur@oasisai.work. An email sent about that lead from
 *      another seat never reached him, so the rep holding the relationship had
 *      no idea a message had gone out under his name's account.
 *
 *   2. THE MAILBOX OWNER WAS COPIED ON HIS OWN MAIL. Sending from the shared
 *      mailbox, `sess.email` IS the From address, so the header read
 *      From: conaugh@ / To: prospect / Cc: conaugh@ / Reply-To: conaugh@ —
 *      a copy of a message already sitting in that mailbox's Sent folder.
 *
 * The rule is ownership, not authorship: the assigned rep is copied because the
 * lead is theirs, and the sender is copied when that is a different person.
 * A lead's assignee is the one address that must be on every message about it,
 * whoever pressed send.
 *
 * PURE AND IMPORT-FREE, deliberately. The SMTP sender imports this for its
 * last-mile filter, so pulling the roster/DB layer in here would drag it into
 * the transport module — and a node test can then exercise the exact header a
 * stranger receives without standing up a database. The async id-to-address
 * lookup lives beside it in assignee-email.ts.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function norm(s: string | null | undefined): string {
  return (s || "").trim().toLowerCase();
}

export type CopyListInput = {
  /** The rep the lead is assigned to. First in line, always. */
  assignedRepEmail?: string | null;
  /** Whoever pressed send. Copied only when they are not already covered. */
  senderEmail?: string | null;
  /** The prospect. Never also a Cc. */
  toEmail: string;
  /**
   * Addresses that must not be copied because they already hold the message —
   * in practice the shared mailbox's own From address, whose Sent folder has it.
   */
  excludeAddresses?: (string | null | undefined)[];
};

/**
 * Ordered, de-duplicated Cc list.
 *
 * Order is meaningful: the assigned rep leads, because `pickReplyTo` takes the
 * first entry and a prospect's reply should reach the person who owns the
 * relationship rather than whoever happened to send.
 */
export function buildCopyList(input: CopyListInput): string[] {
  return filterCopyAddresses([input.assignedRepEmail, input.senderEmail], {
    toEmail: input.toEmail,
    exclude: input.excludeAddresses,
  });
}

/**
 * Keep order, drop the unusable: blanks, malformed addresses, the recipient,
 * anything explicitly excluded, and duplicates (case-insensitively).
 *
 * A malformed stored address is dropped rather than passed through, because an
 * SMTP header that fails to parse can reject the WHOLE message — one bad row in
 * the roster would stop the prospect's email, not just the internal copy.
 */
export function filterCopyAddresses(
  candidates: (string | null | undefined)[],
  opts: { toEmail: string; exclude?: (string | null | undefined)[] },
): string[] {
  const to = norm(opts.toEmail);
  const excluded = new Set((opts.exclude || []).map(norm).filter(Boolean));
  const out: string[] = [];
  const seen = new Set<string>();

  for (const raw of candidates) {
    const value = (raw || "").trim();
    const key = norm(value);
    if (!key) continue;
    if (!EMAIL_RE.test(value)) continue;
    if (key === to) continue;
    if (excluded.has(key)) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

/**
 * The single Reply-To. First copy recipient, i.e. the assigned rep when there
 * is one, else the sender, else null so the caller leaves the header off and
 * replies land on the From address.
 */
export function pickReplyTo(copyList: string[]): string | null {
  return copyList.length ? copyList[0] : null;
}

/**
 * Last-mile filter applied by the SENDER, which is the only layer that knows
 * its own From address.
 *
 * Separated from the transport so it can be tested without SMTP. This is the
 * step that stops the shared mailbox copying itself: sending as conaugh@ and
 * Cc'ing conaugh@ produced From, Cc and Reply-To all one address, delivering a
 * duplicate of a message already in that mailbox's Sent folder.
 */
export function finalizeCopyList(
  cc: string | string[] | null | undefined,
  opts: { to: string; fromAddress: string },
): string[] {
  return filterCopyAddresses(Array.isArray(cc) ? cc : [cc], {
    toEmail: opts.to,
    exclude: [opts.fromAddress],
  });
}

/** Shared with assignee-email.ts so both agree on what counts as an address. */
export function isAddressShaped(value: string): boolean {
  return EMAIL_RE.test((value || "").trim());
}
