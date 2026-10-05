/**
 * typed-recipient.ts — what the lead drawer's email composer does with an
 * address the rep typed in.
 *
 * The recipient box is editable (CC 2026-09-06), so a rep can email whoever a
 * prospect names on a call. #401 then made a successful send to a new address
 * SAVE it onto the record through /api/leads/[id]/set-field, and set-field
 * mirrors `email` onto the linked application. That was written for OASIS and
 * reached SunBiz as well: a rep who emailed a merchant's bookkeeper replaced
 * the merchant's email of record on the lead AND the application, which is
 * what the generated application PDF and the lender submission carry.
 *
 * Before #401 SunBiz's composer never wrote the email of record; it could only
 * send to the address on file. SunBiz gets that back: nothing here writes the
 * record. A rep may still send to any address (CC's 2026-09-06 request, made
 * for SunBiz's leads with no email), and the one on file changes only when
 * someone edits it on purpose (the Owner tab's "+ Add / edit a field"). OASIS
 * keeps #401's save.
 *
 * Decided by the tenant's brand through the fail-closed map in
 * lib/email/brand-for-tenant.ts, never by a list of names here. A slug the map
 * does not know gets NO save: leaving a record alone is the safe side of not
 * knowing whose record it is.
 */
import { brandForTenant } from "@/lib/email/brand-for-tenant";

/** Does a send to a newly typed address save that address onto the record? */
export function savesTypedRecipient(tenantSlug: string | null | undefined): boolean {
  return brandForTenant({ tenantSlug }) === "oasis";
}

/**
 * The line under the recipient box. It has to say what will actually happen,
 * so it is chosen from the same answer that decides the save — two separate
 * decisions are how a warning ends up promising something the code won't do.
 */
export function typedRecipientNote(args: { saves: boolean; hasAddressOnFile: boolean }): string {
  if (args.saves) {
    // #401's wording, unchanged for OASIS.
    return args.hasAddressOnFile
      ? "Sending to a different address than the one on file — it'll be saved to this lead."
      : "New address — it'll be saved to this lead so the next person isn't stuck.";
  }
  return args.hasAddressOnFile
    ? "Sending to a different address than the one on file — the email on file won't change. Edit it on the Owner tab if it should."
    : "No email on file — this address is used for this send only. Add it on the Owner tab to keep it.";
}
