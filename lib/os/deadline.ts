/**
 * lib/os/deadline.ts - a read either answers inside its budget or becomes an
 * error. Nothing in the OS may wait on a promise forever.
 *
 * WHY. The root loading boundary (app/loading.tsx) draws a skeleton for every
 * route while its server component renders. A read that never settles (a
 * database connection that hangs, a provider that never answers) keeps that
 * skeleton on screen with no error, no log line and no way out: the founder's
 * "the dashboard is loading" complaint. With a deadline, a hung read rejects
 * inside the budget and the existing error boundary (app/error.tsx) renders
 * instead, naming the timeout and offering a reload.
 *
 * The digest is set here on purpose. In production Next.js strips a server
 * error's message before it reaches the client boundary and forwards only
 * `digest`, and it keeps a digest the thrower already set; so app/error.tsx
 * recognises a timeout by READ_DEADLINE_DIGEST, never by parsing a message.
 *
 * Leaf module (no imports) so loaders, routes and the layout can use it
 * without an import cycle. ASCII only (tests/worker-source-one-byte).
 */

/** `digest` carried by every deadline error; what app/error.tsx keys on. */
export const READ_DEADLINE_DIGEST = "READ_DEADLINE";

export class ReadDeadlineError extends Error {
  readonly digest = READ_DEADLINE_DIGEST;
  readonly label: string;
  readonly ms: number;
  constructor(label: string, ms: number) {
    super(`Read did not answer in time: ${label}`);
    this.name = "ReadDeadlineError";
    this.label = label;
    this.ms = ms;
  }
}

/**
 * True when a boundary's `error.digest` is a deadline's. Next may suffix a
 * digest with "@<code>" for its own well-known errors, so the prefix is what
 * is compared, not the whole string.
 */
export function isReadDeadlineDigest(digest: string | null | undefined): boolean {
  if (typeof digest !== "string") return false;
  return digest === READ_DEADLINE_DIGEST || digest.startsWith(`${READ_DEADLINE_DIGEST}@`);
}

/** True for a deadline error, even one that crossed a serialisation boundary. */
export function isReadDeadlineError(err: unknown): boolean {
  return (
    err instanceof ReadDeadlineError ||
    (typeof err === "object" && err !== null && isReadDeadlineDigest((err as { digest?: unknown }).digest as string | undefined))
  );
}

/**
 * `p`, or a ReadDeadlineError once `ms` have passed first. The timer never
 * outlives the race: a read that answers (or fails) early clears it, so no
 * handle keeps a request alive past its response.
 *
 * `label` names the read for the log line and the error message. It is a
 * code-side name ("sales.board", "approvals"), never a table or a tenant.
 */
export async function withDeadline<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ReadDeadlineError(label, ms)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
