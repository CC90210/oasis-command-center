/**
 * The token an opt-out link carries: HMAC-SHA256 of "email|brand" under
 * OASIS_UNSUBSCRIBE_HMAC_SECRET, the first 16 hex characters, with the email
 * lowercased and trimmed.
 *
 * ONE COPY (reviewer of OCC #711, item 31). The link builder
 * (lib/email/tracked-html.ts) and the route that checks the link
 * (app/api/unsubscribe/route.ts) each computed it themselves, held together
 * only by a comment saying they must match. A drift would make every signed
 * link read as unsigned, silently.
 */
import { createHmac } from "node:crypto";

export function unsubscribeToken(email: string, brand: string, secret: string): string {
  return createHmac("sha256", secret)
    .update(`${email.trim().toLowerCase()}|${brand}`)
    .digest("hex")
    .slice(0, 16);
}
