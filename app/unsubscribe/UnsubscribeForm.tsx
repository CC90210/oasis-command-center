"use client";

/**
 * Client island for the /unsubscribe confirmation flow.
 *
 * Pure form state — no Supabase client. The API at /api/unsubscribe does
 * the actual DB write with the service role so this page works for
 * recipients who don't have a dashboard account.
 */

import { useState } from "react";

type Props = {
  email: string;
  brand: string;
  token: string;
};

type Status = "idle" | "submitting" | "ok" | "error";

export default function UnsubscribeForm({ email, brand, token }: Props) {
  const [status, setStatus] = useState<Status>("idle");
  const [errorMsg, setErrorMsg] = useState<string>("");

  async function onConfirm() {
    setStatus("submitting");
    setErrorMsg("");
    try {
      const res = await fetch("/api/unsubscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, brand, token }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const msg = body?.error || `HTTP ${res.status}`;
        setErrorMsg(String(msg));
        setStatus("error");
        return;
      }
      setStatus("ok");
    } catch (e) {
      setErrorMsg((e as Error).message || "network_error");
      setStatus("error");
    }
  }

  if (status === "ok") {
    return (
      <div className="text-center">
        <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-[rgba(0,212,255,0.12)] border border-[rgba(0,212,255,0.4)] mb-4">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#00d4ff" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        </div>
        <h2 className="text-lg font-semibold mb-2">You're unsubscribed</h2>
        <p className="text-[#a8b0bd] text-sm leading-relaxed">
          <span className="text-white font-medium">{email}</span> will no
          longer receive marketing emails
          {brand ? <> from <span className="text-white font-medium">{brand}</span></> : <> from us</>}.
        </p>
        <p className="text-[#a8b0bd] text-xs mt-4">
          Transactional emails (receipts, account notices) may still be sent
          when legally required.
        </p>
      </div>
    );
  }

  return (
    <div>
      <div className="bg-[rgba(0,212,255,0.04)] border border-[rgba(0,212,255,0.14)] rounded-lg px-4 py-3 mb-6">
        <div className="text-[11px] uppercase tracking-wider text-[#6b7280] mb-1">Email address</div>
        <div className="text-sm font-medium text-white break-all">{email}</div>
      </div>

      <button
        type="button"
        onClick={onConfirm}
        disabled={status === "submitting"}
        className="w-full bg-[#00d4ff] hover:bg-[#00b8e0] disabled:bg-[#1a2030] disabled:text-[#6b7280] disabled:cursor-not-allowed text-[#050810] font-semibold py-3 rounded-lg transition-colors"
      >
        {status === "submitting" ? "Unsubscribing…" : "Confirm unsubscribe"}
      </button>

      {status === "error" && (
        <p className="mt-3 text-sm text-red-400 text-center">
          Something went wrong: {errorMsg}. You can also email{" "}
          <a href="mailto:unsubscribe@oasisai.work" className="underline">
            unsubscribe@oasisai.work
          </a>{" "}
          to opt out manually.
        </p>
      )}
    </div>
  );
}
