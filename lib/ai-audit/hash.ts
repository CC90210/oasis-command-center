import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { canonicalJson } from "@/lib/ai-audit/canonical";

/** sha256 hex of a string, as UTF-8. */
export function sha256Hex(text: string | Uint8Array): string {
  return createHash("sha256").update(text).digest("hex");
}

/** The hash the approval gates bind to: sha256 of the canonical JSON. */
export function contentHash(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

/**
 * A UUID derived from a fixed key, so the same onboarding step for the same
 * engagement always names the same row. A retry then collides on the primary
 * key instead of creating a second project or task (onboarding.ts).
 */
export function deterministicUuid(key: string): string {
  const h = createHash("sha256").update(`oasis-ai-audit:${key}`, "utf8").digest("hex");
  // Version 4 layout (the variant/version nibbles set) so every UUID check in
  // the app accepts it; the value is still fully determined by the key.
  const v = (parseInt(h.slice(16, 18), 16) & 0x3f) | 0x80;
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${v.toString(16).padStart(2, "0")}${h.slice(18, 20)}-${h.slice(20, 32)}`;
}

export function newId(): string {
  return randomUUID();
}
