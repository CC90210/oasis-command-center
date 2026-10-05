"use client";

/**
 * Client island for the /unsubscribe confirmation flow.
 *
 * Pure form state — no Supabase client. The API at /api/unsubscribe does
 * the actual DB write with the service role so this page works for
 * recipients who don't have a dashboard account.
 *
 * TWO SHAPES. From an email link the address is in the URL and is shown, not
 * edited. With no address in the link (a mangled copy-paste, a forwarded
 * footer) the recipient types it here. That second shape used to offer only
 * "email us with the subject unsubscribe", which lands in the founder's inbox
 * and reaches BEA's own suppression list, not the email_suppressions table the
 * Worker's senders check (app/unsubscribe/ManualOptOut.tsx). A typed address
 * goes through /api/unsubscribe like a linked one, so the opt-out lands in the
 * store every sender reads.
 */

import { useState } from "react";
import { ManualOptOut } from "./ManualOptOut";

type Props = {
  /** The address from the link, or "" when the link carried none. */
  email: string;
  brand: string;
  token: string;
};

type Status = "idle" | "submitting" | "ok" | "error";

export default function UnsubscribeForm({ email, brand, token }: Props) {
  const typed = !email;
  const [address, setAddress] = useState(email);
  const [status, setStatus] = useState<Status>("idle");
  const [errorMsg, setErrorMsg] = useState<string>("");
  const submitted = address.trim().toLowerCase();

  async function onConfirm() {
    setStatus("submitting");
    setErrorMsg("");
    try {
      const res = await fetch("/api/unsubscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: submitted, brand, token }),
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
        <h2 className="text-lg font-semibold mb-2">You&apos;re unsubscribed</h2>
        <p className="text-[#a8b0bd] text-sm leading-relaxed">
          <span className="text-white font-medium">{submitted}</span> will no
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
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void onConfirm();
      }}
    >
      {typed ? (
        <div className="mb-6 text-left">
          <label htmlFor="unsubscribe-email" className="block text-[11px] uppercase tracking-wider text-[#6b7280] mb-1">
            Email address
          </label>
          <input
            id="unsubscribe-email"
            name="email"
            type="email"
            required
            autoComplete="email"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="The address that received the email"
            className="w-full bg-[rgba(0,212,255,0.04)] border border-[rgba(0,212,255,0.14)] rounded-lg px-4 py-3 text-sm text-white placeholder:text-[#6b7280] focus:border-[#00d4ff] focus:outline-none"
          />
        </div>
      ) : (
        <div className="bg-[rgba(0,212,255,0.04)] border border-[rgba(0,212,255,0.14)] rounded-lg px-4 py-3 mb-6">
          <div className="text-[11px] uppercase tracking-wider text-[#6b7280] mb-1">Email address</div>
          <div className="text-sm font-medium text-white break-all">{email}</div>
        </div>
      )}

      <button
        type="submit"
        disabled={status === "submitting"}
        className="w-full bg-[#00d4ff] hover:bg-[#00b8e0] disabled:bg-[#1a2030] disabled:text-[#6b7280] disabled:cursor-not-allowed text-[#050810] font-semibold py-3 rounded-lg transition-colors"
      >
        {status === "submitting" ? "Unsubscribing…" : "Confirm unsubscribe"}
      </button>

      {status === "error" && (
        <p className="mt-3 text-sm text-red-400 text-center">
          Something went wrong: {errorMsg}. You can also{" "}
          <ManualOptOut linkClassName="underline" /> to opt out manually.
        </p>
      )}
      {typed && status !== "error" && (
        <p className="text-[#a8b0bd] text-xs mt-4 text-center">
          Or <ManualOptOut linkClassName="text-[#00d4ff] underline" /> to opt out manually.
        </p>
      )}
    </form>
  );
}
