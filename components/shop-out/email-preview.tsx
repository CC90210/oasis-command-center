"use client";

/**
 * EmailPreview — Adon spec section 4 (2026-06-10).
 *
 * Read-only render of the subject + body + To + CC for the FIRST lender
 * in the plan. The operator uses this to sanity-check the rendered
 * Jordan template before clicking Send. We don't render per-lender
 * previews — the only field that varies between lenders is the funder
 * name in the body's "Hi {funder_name}," line, and showing N preview
 * cards would dilute the signal.
 *
 * Pure display — no state, no actions. Confirm-modal handles the gate.
 */

type Props = {
  funderName: string;
  to: string | null;
  cc: string[];
  subject: string;
  body: string;
  /** Optional — operator-typed plain English about why this funder is on the list. */
  matchNarrative?: string;
};

export default function EmailPreview({
  funderName,
  to,
  cc,
  subject,
  body,
  matchNarrative,
}: Props) {
  return (
    <div className="overflow-hidden rounded-md border border-zinc-800 bg-zinc-950/40">
      <div className="border-b border-zinc-800 bg-zinc-950/60 px-4 py-2 text-xs uppercase tracking-wide text-zinc-400">
        Preview — {funderName} (first lender in the plan)
      </div>
      <div className="space-y-3 p-4 text-sm">
        <header className="grid gap-1 text-zinc-200">
          <div>
            <span className="text-xs uppercase tracking-wide text-zinc-500">From: </span>
            <span className="font-mono">SunBiz Submissions &lt;submissions@sunbizfunding.com&gt;</span>
          </div>
          <div>
            <span className="text-xs uppercase tracking-wide text-zinc-500">To: </span>
            <span className="font-mono">{to || "(missing — lender has no contact email)"}</span>
          </div>
          {cc.length > 0 && (
            <div>
              <span className="text-xs uppercase tracking-wide text-zinc-500">Cc: </span>
              <span className="font-mono">{cc.join(", ")}</span>
            </div>
          )}
          <div>
            <span className="text-xs uppercase tracking-wide text-zinc-500">Subject: </span>
            <span className="font-medium">{subject}</span>
          </div>
        </header>

        <hr className="border-zinc-800" />

        <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed text-zinc-100">
          {body}
        </pre>

        {matchNarrative && (
          <>
            <hr className="border-zinc-800" />
            <div className="rounded-md border border-zinc-800 bg-zinc-950/30 p-3 text-xs text-zinc-400">
              <div className="mb-1 uppercase tracking-wide text-zinc-500">Match rationale</div>
              {matchNarrative}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
