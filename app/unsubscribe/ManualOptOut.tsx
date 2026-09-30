/**
 * The manual way to opt out, for a recipient whose confirmation failed or who
 * would rather write: email the founder's inbox with the subject
 * "unsubscribe".
 *
 * It used to name an unsubscribe@ alias on our domain that never existed, so a
 * recipient exercising a legal right (CASL) got a bounce. conaugh@oasisai.work
 * is the one verified inbox (tests/verified-mailboxes.test.ts keeps it on the
 * list), and "unsubscribe" is the subject BEA's inbox check reacts to:
 * email_engine.py auto-suppresses a sender whose subject says STOP or
 * UNSUBSCRIBE.
 *
 * WHAT THAT SUPPRESSION REACHES, AND WHAT IT DOES NOT. BEA records it with
 * casl_compliance.add_suppression, which appends to data/email_suppressions.csv
 * on CC's machine; BEA's own send gateway reads that file. The Worker's senders
 * (drips, bulk email, the funnel and next-step emails, cold sending) check only
 * the email_suppressions table, and only /api/unsubscribe writes that table. So
 * an opt-out that arrives here by email is NOT seen by those senders until
 * someone enters it into email_suppressions by hand, or until BEA's
 * add_suppression also writes the table (a BEA change proposed for CC's
 * approval). That is why /unsubscribe asks for the address and records it
 * through /api/unsubscribe first, and offers this only as the fallback.
 *
 * No hooks, so the server page and the client form both render it, and the
 * test can render it under react-server.
 */
import { CONTACT_EMAIL } from "@/lib/marketing/routes";

export const MANUAL_UNSUBSCRIBE_HREF = `mailto:${CONTACT_EMAIL}?subject=unsubscribe`;

export function ManualOptOut({ linkClassName }: { linkClassName?: string }) {
  return (
    <>
      email{" "}
      <a href={MANUAL_UNSUBSCRIBE_HREF} className={linkClassName}>
        {CONTACT_EMAIL}
      </a>{" "}
      with the subject &ldquo;unsubscribe&rdquo;
    </>
  );
}
