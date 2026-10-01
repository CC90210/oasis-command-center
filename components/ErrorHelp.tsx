/**
 * What a person should do when a page crashes: try again, and if it keeps
 * happening, send us the error code through the support form or by email.
 *
 * Shared by app/error.tsx and app/global-error.tsx so the two cannot drift.
 * Both used to say "check the Vercel function logs": a hosting provider this
 * app has left, and a log no client can open. The address is CONTACT_EMAIL, the
 * one verified inbox (config/verified-mailboxes.json).
 *
 * PROSPECT-FACING PAGES GET NO OASIS CONTACT. app/error.tsx is the root
 * boundary, so it also catches a crash on the pages a client's own prospects
 * and customers open: a client's public form (/f/<client>/<form>), a document
 * sent for signature (/sign/<token>) and a client-branded opt-out
 * (/unsubscribe?brand=...). Sending that person to OASIS's support form or
 * OASIS's founder named the vendor behind the client's brand, and let a
 * stranger file tickets into OASIS's own support desk. On those paths the copy
 * points them back to the business that sent them, and still shows the code.
 *
 * `inline` is for global-error.tsx: when the root layout itself failed, the
 * stylesheet may not have loaded, so it carries its own styles.
 *
 * `timedOut` is the one failure the boundary can name (2026-10-01, OS plan
 * W0): a workspace read that did not answer inside its budget
 * (lib/os/deadline.ts). The copy says so plainly and asks for a reload; it
 * never names a table, a query or a tenant - the label stays in the Worker's
 * logs. Every other error keeps the generic copy.
 *
 * No hooks, so it renders on the server and under the react-server test
 * condition. The boundaries read the path (usePathname) and pass it in.
 */
import { CONTACT_EMAIL } from "@/lib/marketing/routes";
import { SUPPORT_FORM_PATH } from "@/lib/delivery/support-form";

/** What a timed-out read says, on every surface. Plain words, no internals. */
export const TIMED_OUT_COPY = "A workspace read timed out before the page could finish loading.";

/**
 * Public pages a client's prospects and customers land on. Each is also a
 * public prefix in middleware.ts; tests/client-route-gating.test.ts pins both.
 */
export const PROSPECT_FACING_PREFIXES = ["/f/", "/sign/", "/unsubscribe"] as const;

/** True for a page a client's prospect or customer may be looking at. */
export function isProspectFacingPath(pathname: string | null | undefined): boolean {
  const p = (pathname || "").split(/[?#]/)[0];
  return PROSPECT_FACING_PREFIXES.some((prefix) =>
    prefix.endsWith("/") ? p.startsWith(prefix) : p === prefix || p.startsWith(`${prefix}/`),
  );
}

const INLINE = {
  text: { fontSize: "0.875rem", color: "#9ba3b1", marginTop: "0.5rem", lineHeight: 1.55 },
  link: { color: "#f5f7fa", textDecoration: "underline" },
  code: {
    fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace",
    fontSize: 11,
    color: "#9ba3b1",
    background: "#020409",
    border: "1px solid #1e2532",
    borderRadius: 6,
    padding: "0.5rem 0.75rem",
    marginTop: "0.875rem",
    wordBreak: "break-all" as const,
  },
};

export function ErrorHelp({
  digest,
  inline = false,
  prospectFacing = false,
  timedOut = false,
}: {
  digest?: string;
  inline?: boolean;
  /** A client's prospect may be reading: name no OASIS contact (see above). */
  prospectFacing?: boolean;
  /** The error is a read deadline (lib/os/deadline.ts): say so, ask for a reload. */
  timedOut?: boolean;
}) {
  const linkClass = inline ? undefined : "text-accent underline-offset-2 hover:underline";
  const linkStyle = inline ? INLINE.link : undefined;
  const textClass = inline ? undefined : "text-sm text-fg-muted leading-relaxed";
  const textStyle = inline ? INLINE.text : undefined;
  // "Reload the page" for a timeout (the read is retried from scratch); "Try
  // again" for everything else, which is what the boundary's button does.
  const lead = timedOut ? `${TIMED_OUT_COPY} Reload the page.` : "Try again.";
  return (
    <>
      {prospectFacing ? (
        <p className={textClass} style={textStyle}>
          {lead} If it keeps happening, contact the business that sent you here
          {digest ? " and give them the code below" : " and tell them what you were doing"}.
        </p>
      ) : (
        <p className={textClass} style={textStyle}>
          {lead} If it keeps happening, {digest ? "send us the code below" : "tell us what you were doing"}{" "}
          through the{" "}
          <a href={SUPPORT_FORM_PATH} target="_blank" rel="noopener noreferrer" className={linkClass} style={linkStyle}>
            support form
          </a>{" "}
          or by email to{" "}
          <a href={`mailto:${CONTACT_EMAIL}`} className={linkClass} style={linkStyle}>
            {CONTACT_EMAIL}
          </a>
          .
        </p>
      )}
      {digest ? (
        <div
          className={
            inline
              ? undefined
              : "text-[11px] font-mono text-fg-dim bg-bg-deep border border-bg-border rounded-md px-3 py-2 break-all"
          }
          style={inline ? INLINE.code : undefined}
        >
          Error code: {digest}
        </div>
      ) : null}
    </>
  );
}
