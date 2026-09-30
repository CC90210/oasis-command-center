/**
 * What a person should do when a page crashes: try again, and if it keeps
 * happening, send us the error code through the support form or by email.
 *
 * Shared by app/error.tsx and app/global-error.tsx so the two cannot drift.
 * Both used to say "check the Vercel function logs": a hosting provider this
 * app has left, and a log no client can open. The address is CONTACT_EMAIL, the
 * one verified inbox (config/verified-mailboxes.json).
 *
 * `inline` is for global-error.tsx: when the root layout itself failed, the
 * stylesheet may not have loaded, so it carries its own styles.
 *
 * No hooks, so it renders on the server and under the react-server test
 * condition.
 */
import { CONTACT_EMAIL } from "@/lib/marketing/routes";
import { SUPPORT_FORM_PATH } from "@/lib/delivery/support-form";

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

export function ErrorHelp({ digest, inline = false }: { digest?: string; inline?: boolean }) {
  const linkClass = inline ? undefined : "text-accent underline-offset-2 hover:underline";
  const linkStyle = inline ? INLINE.link : undefined;
  return (
    <>
      <p
        className={inline ? undefined : "text-sm text-fg-muted leading-relaxed"}
        style={inline ? INLINE.text : undefined}
      >
        Try again. If it keeps happening, {digest ? "send us the code below" : "tell us what you were doing"}{" "}
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
