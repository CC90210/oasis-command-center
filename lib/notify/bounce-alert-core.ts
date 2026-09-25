import { shouldAlert, type AlertState } from "./alert-decay";

function stablePart(value: string): string {
  return String(value || "unknown")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "") || "unknown";
}

/** One decay episode per mailbox/brand, so one brand cannot hide another. */
export function bounceAlertKey(brand: string): string {
  return `bounce_reader:${stablePart(brand)}`;
}

/**
 * Keep the identity coarse. Provider timestamps and retry wording are details,
 * not new incidents; a materially different failure class still cuts through.
 */
export function bounceFailureSignature(
  errorClass: string,
  _detail?: string,
): string {
  return `bounce_reader:${stablePart(errorClass)}`;
}

export function decideBounceAlert(
  errorClass: string,
  detail: string,
  state: AlertState | null | undefined,
  now: Date = new Date(),
) {
  const signature = bounceFailureSignature(errorClass, detail);
  return { signature, ...shouldAlert(signature, state, now) };
}
