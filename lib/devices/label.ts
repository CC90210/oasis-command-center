/**
 * lib/devices/label.ts - the name a person gives one of their computers.
 *
 * Pure (no server-only import), so the rules are tested without a request and the
 * same function can gate the input in the browser. It lives here, not in the
 * route file, because a Next.js route module may export only its HTTP handlers.
 *
 * A Mac with no hostname set reports the router's DHCP address as its name, so a
 * pairing could be called "192.168.11.27 (Mac)" with no way to change it. See
 * PATCH /api/devices (app/api/devices/route.ts).
 */

/** Longest name a person may give a computer. The list renders it on one line. */
export const DEVICE_LABEL_MAX = 60;

export type DeviceLabelProblem = "label_required" | "label_too_long" | "label_invalid";

/**
 * C0 control characters, DEL, and the two Unicode line separators (U+2028 and
 * U+2029). Built from code points rather than written as escapes in a literal,
 * so no tool between this file and the compiler can turn an escape into a raw
 * line break inside the pattern.
 */
const UNSAFE_IN_NAME = new RegExp(
  "[\\x00-\\x1f\\x7f" + String.fromCharCode(0x2028, 0x2029) + "]",
);

/**
 * Why a proposed computer name is refused, or null when it is fine: one
 * printable line, trimmed, non-empty and short. No control characters or line
 * separators (a newline would break the one-line list and any log or email that
 * quotes it).
 */
export function deviceLabelProblem(raw: unknown): DeviceLabelProblem | null {
  if (typeof raw !== "string") return "label_required";
  const label = raw.trim();
  if (!label) return "label_required";
  if (label.length > DEVICE_LABEL_MAX) return "label_too_long";
  if (UNSAFE_IN_NAME.test(label)) return "label_invalid";
  return null;
}

/** The sentence a person reads for a refused name. */
export function deviceLabelProblemWords(problem: DeviceLabelProblem | string): string {
  if (problem === "label_required") return "Type a name for this computer.";
  if (problem === "label_too_long") return `Keep the name to ${DEVICE_LABEL_MAX} characters or fewer.`;
  if (problem === "label_invalid") return "Use plain letters, numbers and spaces in the name.";
  return "Could not rename this computer. Try again.";
}
