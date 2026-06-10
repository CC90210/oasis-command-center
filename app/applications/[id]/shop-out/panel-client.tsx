"use client";

/**
 * ShopOutPanelClient — the client island the server-rendered panel hands
 * off to. Owns the checkbox state + the confirm modal + the POST to
 * /shop-out/run.
 *
 * Split off so the page.tsx stays a server component (cheaper DB access,
 * no client-bundle overhead for the deal resolution work).
 */

import { useMemo, useState } from "react";
import DerivedCcList, {
  type DerivedAgentEntry,
} from "@/components/shop-out/derived-cc-list";
import EmailPreview from "@/components/shop-out/email-preview";
import ConfirmModal from "@/components/shop-out/confirm-modal";
import { deriveSignerName } from "@/lib/lenders/derive-signer-label";

type Preview = {
  funderName: string;
  to: string | null;
  cc: string[];
  subject: string;
  body: string;
  matchNarrative?: string;
};

type Props = {
  applicationId: string;
  merchantName: string;
  fundersCount: number;
  lenderIds: string[];
  derivedAgents: DerivedAgentEntry[];
  missingFields: string[];
  preview: Preview | null;
  signedInUserName: string;
};

export default function ShopOutPanelClient({
  applicationId,
  merchantName,
  fundersCount,
  lenderIds,
  derivedAgents,
  missingFields,
  preview,
  signedInUserName: _signedInUserName,
}: Props) {
  // CC state — initialized with all derived agents pre-checked per spec 2.3.
  const [checkedEmails, setCheckedEmails] = useState<string[]>(
    () => derivedAgents.map((a) => a.email),
  );
  const [dryRun, setDryRun] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<
    | null
    | {
        ok: true;
        dry_run?: boolean;
        run_id?: string;
        sent?: number;
        failed?: number;
        previews?: Array<{ funder: string; subject: string }>;
      }
    | { ok: false; error: string; missing?: string[]; detail?: string }
  >(null);

  // Signer derivation — uses the same pure rule the server uses (via
  // lib/lenders/derive-signer-label.ts). No drift risk: change the rule
  // in one file and both sides update.
  const signerName = useMemo(
    () => deriveSignerName(checkedEmails, derivedAgents),
    [checkedEmails, derivedAgents],
  );

  const blocked = missingFields.length > 0 || lenderIds.length === 0;

  async function fireRun() {
    setSending(true);
    try {
      const res = await fetch(
        `/api/applications/${applicationId}/shop-out/run`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            lender_ids: lenderIds,
            cc_emails: checkedEmails,
            dry_run: dryRun,
          }),
        },
      );
      const data = (await res.json()) as
        | {
            ok: true;
            dry_run?: boolean;
            run_id?: string;
            sent?: number;
            failed?: number;
            previews?: Array<{ funder: string; subject: string }>;
          }
        | { ok: false; error: string; missing?: string[]; detail?: string };
      setResult(data);
    } catch (e) {
      setResult({
        ok: false,
        error: e instanceof Error ? e.message : "network_error",
      });
    } finally {
      setSending(false);
      setConfirmOpen(false);
    }
  }

  return (
    <div className="mt-8 space-y-6">
      <DerivedCcList
        derived={derivedAgents}
        checkedEmails={checkedEmails}
        onChange={setCheckedEmails}
        disabled={sending}
      />

      {preview && (
        <EmailPreview
          funderName={preview.funderName}
          to={preview.to}
          cc={preview.cc}
          subject={preview.subject}
          body={preview.body}
          matchNarrative={preview.matchNarrative}
        />
      )}

      <div className="flex flex-wrap items-center gap-4 rounded-md border border-zinc-800 bg-zinc-950/40 p-4">
        <label className="flex items-center gap-2 text-sm text-zinc-200">
          <input
            type="checkbox"
            className="h-4 w-4 rounded border-zinc-700 bg-zinc-900 text-emerald-500 focus:ring-emerald-500/40"
            checked={dryRun}
            disabled={sending}
            onChange={(e) => setDryRun(e.target.checked)}
          />
          Dry-run (no Gmail calls, no DB writes — preview only)
        </label>

        <button
          type="button"
          className="ml-auto rounded-md bg-emerald-600 px-5 py-2 text-sm font-medium text-emerald-50 hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-60"
          disabled={blocked || sending}
          onClick={() => setConfirmOpen(true)}
        >
          {dryRun ? "Dry-run preview" : "Send shop-out"}
        </button>
      </div>

      <ConfirmModal
        open={confirmOpen}
        fundersCount={fundersCount}
        merchantName={merchantName}
        ccEmails={checkedEmails}
        signerName={signerName}
        fromAddress="submissions@sunbizfunding.com"
        onSend={fireRun}
        onCancel={() => setConfirmOpen(false)}
        sending={sending}
      />

      {result && (
        <div
          className={`rounded-md border p-4 text-sm ${
            result.ok
              ? "border-emerald-700/50 bg-emerald-950/30 text-emerald-100"
              : "border-rose-700/50 bg-rose-950/30 text-rose-100"
          }`}
        >
          {result.ok ? (
            result.dry_run ? (
              <>
                <div className="font-medium">Dry-run complete</div>
                <div className="mt-1 text-xs text-emerald-200/80">
                  {result.previews?.length || 0} per-funder preview
                  {(result.previews?.length || 0) === 1 ? "" : "s"} rendered. Nothing was sent.
                </div>
              </>
            ) : (
              <>
                <div className="font-medium">
                  Sent: {result.sent || 0} / Failed: {result.failed || 0}
                </div>
                {result.run_id && (
                  <div className="mt-1 text-xs text-emerald-200/80">
                    Run ID: <span className="font-mono">{result.run_id}</span>
                  </div>
                )}
              </>
            )
          ) : (
            <>
              <div className="font-medium">Run failed: {result.error}</div>
              {result.missing && result.missing.length > 0 && (
                <div className="mt-1 text-xs text-rose-200/80">
                  Missing fields: {result.missing.join(", ")}
                </div>
              )}
              {result.detail && (
                <div className="mt-1 text-xs text-rose-200/80">{result.detail}</div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
