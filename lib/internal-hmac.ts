import "server-only";
/**
 * Shared HMAC verifier for the VPS→dashboard internal routes.
 *
 * There is exactly ONE trust boundary between the VPS daemons and this app:
 * an HMAC-SHA256 over the RAW request body keyed with OASIS_OUTBOUND_HMAC_SECRET
 * (the same secret send_gateway uses for /api/outbound/log). A browser can never
 * hold it, so a valid signature is proof the caller is a VPS process.
 *
 * This lives in one file because /api/internal/apply-extraction and
 * /api/internal/extraction-doc-url must agree byte-for-byte on the construction.
 * Two hand-rolled copies of a signature check is how one of them quietly grows a
 * length-compare bug that the other does not have.
 *
 * Fail closed: a missing secret, a missing header, or a wrong-length digest is
 * `false`, never an exception and never a pass.
 */

import { createHmac, timingSafeEqual } from "crypto";

export function verifyInternalHmac(rawBody: string, header: string | null): boolean {
  const secret = (process.env.OASIS_OUTBOUND_HMAC_SECRET || "").trim();
  if (!secret || !header) return false;
  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(header.trim(), "utf8");
  // timingSafeEqual throws on a length mismatch — guard so a wrong-length
  // signature is a clean false rather than a 500 that leaks "wrong length".
  return a.length === b.length && timingSafeEqual(a, b);
}
