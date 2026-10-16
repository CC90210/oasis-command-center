/**
 * One consent box (email or SMS), as every public form draws it.
 *
 * CC, 2026-10-16: the full legal paragraph under every form ("where it says our
 * address") is too much; make it a link or a drop-down. So each box shows ONE
 * line (consentSummaryText: who is asking, what for, how to stop) and the full
 * disclosure sits under "Full terms", a native <details> that needs no script.
 *
 * The full text stays in the page and stays tied to the box: the checkbox's
 * aria-describedby points at it, so a screen reader announces it with the box
 * even while it is collapsed. The ledger records that exact text, stamped
 * CONSENT_DISCLOSURE_VERSION v2 (lib/consent/ledger-disclosure.ts).
 *
 * Used by FormPublicClient (every /f/ form), AuditForm (/audit) and the /book
 * page, so the three can never show different consent. ASCII only.
 */
import {
  consentDisclosureText,
  consentSummaryText,
  type ConsentChannel,
  type ConsentIdentity,
} from "@/lib/consent/ledger-disclosure";

export function ConsentChoice({
  id,
  channel,
  identity,
  checked,
  onChange,
  name,
  variant = "app",
}: {
  id: string;
  channel: ConsentChannel;
  identity: ConsentIdentity;
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** Form field name, for a form that also submits natively (AuditForm). */
  name?: string;
  /** "app" for operator-styled forms, "marketing" for the public site's palette. */
  variant?: "app" | "marketing";
}) {
  const termsId = `${id}-terms`;
  return (
    <div className="flex items-start gap-3 py-1">
      <input
        id={id}
        name={name}
        value={name ? "true" : undefined}
        type="checkbox"
        autoComplete="off"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        aria-describedby={termsId}
        className={`mt-0.5 h-4 w-4 shrink-0 rounded ${variant === "marketing" ? "border-ops-edge" : "border-bg-border"}`}
      />
      <div className="min-w-0 text-[12px] leading-relaxed text-fg-muted">
        <label htmlFor={id} className="cursor-pointer">
          {consentSummaryText(channel, identity)}
        </label>
        <details className="mt-1">
          {/* text-fg-muted, not fg-dim: fg-dim on a light-theme form's panel is about
              2.3:1, below the 4.5:1 a legal text and its control need (Codex on #633).
              fg-muted is the colour the full disclosure always used. */}
          <summary className="w-fit cursor-pointer list-none text-[12px] text-fg-muted underline underline-offset-2 hover:text-fg [&::-webkit-details-marker]:hidden">
            Full terms
          </summary>
          <p id={termsId} className="mt-1 text-[12px] leading-relaxed text-fg-muted">
            {consentDisclosureText(channel, identity)}
          </p>
        </details>
      </div>
    </div>
  );
}
