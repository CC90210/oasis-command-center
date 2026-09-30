/**
 * The manual way to opt out, for a recipient whose link lost its address or
 * whose confirmation failed: write to the founder's inbox with the subject
 * "unsubscribe".
 *
 * It used to name an unsubscribe@ alias on our domain that never existed, so a
 * recipient exercising a legal right (CASL) got a bounce. conaugh@oasisai.work
 * with that subject is what BEA already suppresses on: casl_compliance.py
 * builds the List-Unsubscribe header as <mailto:{sender}?subject=unsubscribe>,
 * and email_engine.py suppresses a sender whose subject says STOP or
 * UNSUBSCRIBE. tests/verified-mailboxes.test.ts keeps the address on the
 * verified list.
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
