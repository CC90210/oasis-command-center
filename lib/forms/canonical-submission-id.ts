import { createHash } from "node:crypto";

/**
 * Stable UUID for one form step completion.
 *
 * The primary-key conflict makes the first write atomic under concurrent
 * browser retries even where the database has no composite unique constraint
 * for (form_id, lead_id, step_index). Existing historical rows are discovered
 * and updated before this ID is needed.
 */
export function canonicalFormSubmissionId(
  formId: string,
  leadId: string,
  stepIndex: number,
): string {
  const hex = createHash("sha256")
    .update(`${formId}\u0000${leadId}\u0000${stepIndex}`, "utf8")
    .digest("hex")
    .slice(0, 32)
    .split("");
  // RFC 4122 version/variant bits; the hash remains the namespace.
  hex[12] = "5";
  hex[16] = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  const value = hex.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}
