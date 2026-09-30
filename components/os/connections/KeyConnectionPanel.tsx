"use client";

/**
 * KeyConnectionPanel — the connect / test / disconnect controls for a
 * Connections-framework app that authenticates with a pasted key (Stripe's
 * restricted key), rendered inside the ConnectorDrawer.
 *
 * It never decides a status. Every action posts to
 * /api/connections/[provider]/*, the server probes Stripe live and records the
 * result, and the hub re-reads every status from the server afterwards
 * (onChanged → router.refresh). The card only goes green from that server read.
 *
 * Stripe is the only restricted-key provider today, so the pre-check below is
 * Stripe's key format; a second such provider brings its own check.
 *
 * The key: a password field with autocomplete off. A full secret key (sk_…)
 * or publishable key (pk_…) is refused HERE, before it leaves the browser —
 * the same rule the server enforces (lib/connections/rules.ts
 * checkStripeRestrictedKey) — and the field is cleared so a full secret key is
 * not left sitting in the page.
 */

import { useState } from "react";
import { checkStripeRestrictedKey } from "@/lib/connections/rules";
import type { RestrictedKeyConfig } from "@/lib/connections/registry";
import type { ConnectorStatus } from "@/lib/os/connectors";
import { Notice, type NoticeValue } from "@/components/os/connections/Notice";

type Busy = "connect" | "test" | "disconnect" | null;

async function post(url: string, body?: unknown): Promise<{ ok: boolean; status: number; data: Record<string, unknown> | null }> {
  const res = await fetch(url, {
    method: "POST",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  });
  const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  return { ok: res.ok && data?.ok === true, status: res.status, data };
}

function serverMessage(r: { status: number; data: Record<string, unknown> | null }, fallback: string): string {
  const message = r.data?.message;
  if (typeof message === "string" && message.trim()) return message;
  const error = r.data?.error;
  return typeof error === "string" ? `${fallback} (${error}).` : `${fallback} (HTTP ${r.status}).`;
}

export function KeyConnectionPanel({
  providerId,
  providerName,
  config,
  status,
  onChanged,
}: {
  providerId: string;
  providerName: string;
  config: RestrictedKeyConfig;
  status: ConnectorStatus | null;
  onChanged: () => void;
}) {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState<Busy>(null);
  const [notice, setNotice] = useState<NoticeValue>(null);
  const [confirming, setConfirming] = useState(false);
  const [replacing, setReplacing] = useState(false);

  const hasConnection = status?.kind === "connected" || status?.kind === "configured" || status?.kind === "attention";
  const showForm = !hasConnection || replacing;
  const base = `/api/connections/${encodeURIComponent(providerId)}`;

  const run = async (kind: Exclude<Busy, null>, action: () => Promise<void>) => {
    setBusy(kind);
    setNotice(null);
    try {
      await action();
    } catch (error) {
      console.error(`[connections.${kind}]`, error);
      setNotice({ tone: "err", text: "Could not reach OASIS. Check your connection and try again." });
    } finally {
      setBusy(null);
    }
  };

  const connect = () =>
    run("connect", async () => {
      const check = checkStripeRestrictedKey(key);
      if (!check.ok) {
        if (check.error === "secret_key_refused" || check.error === "publishable_key_refused") setKey("");
        setNotice({ tone: "err", text: check.message });
        return;
      }
      const r = await post(`${base}/connect`, { key: check.key });
      if (!r.ok) {
        setNotice({ tone: "err", text: serverMessage(r, `${providerName} could not be connected`) });
        return;
      }
      setKey("");
      setReplacing(false);
      const conn = r.data?.connection as { account_label?: string | null } | undefined;
      setNotice({
        tone: "ok",
        text: `${providerName} connected${conn?.account_label ? `: ${conn.account_label}` : ""}. The live check passed.`,
      });
      onChanged();
    });

  const test = () =>
    run("test", async () => {
      const r = await post(`${base}/test`);
      if (!r.ok) {
        setNotice({ tone: "err", text: serverMessage(r, "The check could not run") });
        return;
      }
      const conn = r.data?.connection as { verified?: boolean; last_health_detail?: string | null } | undefined;
      setNotice(
        conn?.verified
          ? { tone: "ok", text: `The live check with ${providerName} passed.` }
          : { tone: "err", text: conn?.last_health_detail || `The live check with ${providerName} did not pass.` },
      );
      onChanged();
    });

  const disconnect = () =>
    run("disconnect", async () => {
      const r = await post(`${base}/disconnect`);
      setConfirming(false);
      if (!r.ok) {
        setNotice({ tone: "err", text: serverMessage(r, `${providerName} could not be disconnected`) });
        return;
      }
      setNotice({ tone: "ok", text: `${providerName} disconnected. The stored key was deleted.` });
      onChanged();
    });

  return (
    <div className="space-y-5">
      <Notice notice={notice} />

      {hasConnection && (
        <section>
          <h3 className="mb-2 text-xs font-medium text-fg-dim">Connected account</h3>
          <p className="text-[13px] leading-5 text-fg">{status?.account ?? "Account name not available"}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" onClick={test} disabled={busy !== null} className="btn-secondary">
              {busy === "test" ? "Checking…" : "Test again"}
            </button>
            {!confirming ? (
              <button type="button" onClick={() => setConfirming(true)} disabled={busy !== null} className="btn-secondary">
                Disconnect
              </button>
            ) : null}
            {!replacing && (
              <button
                type="button"
                onClick={() => setReplacing(true)}
                disabled={busy !== null}
                className="rounded-md px-2 py-1.5 text-[13px] text-fg-muted underline-offset-2 hover:text-fg hover:underline"
              >
                Use a new key
              </button>
            )}
          </div>
          {confirming && (
            <div className="mt-3 rounded-lg border border-hairline bg-bg-raised px-3 py-3">
              <p className="text-[13px] leading-5 text-fg">
                Disconnect {providerName}? OASIS deletes the stored key and stops reading this account. You can connect
                it again at any time.
              </p>
              <div className="mt-3 flex gap-2">
                <button type="button" onClick={disconnect} disabled={busy !== null} className="btn-danger">
                  {busy === "disconnect" ? "Disconnecting…" : "Disconnect"}
                </button>
                <button type="button" onClick={() => setConfirming(false)} disabled={busy !== null} className="btn-secondary">
                  Cancel
                </button>
              </div>
            </div>
          )}
        </section>
      )}

      {showForm && (
        <section>
          <h3 className="mb-2 text-xs font-medium text-fg-dim">
            {hasConnection ? "Replace the key" : `Connect ${providerName}`}
          </h3>
          <p className="text-[13px] leading-5 text-fg">{config.accessSummary}</p>
          <ol className="mt-3 list-decimal space-y-1.5 pl-5 text-[13px] leading-5 text-fg-muted">
            {config.setupSteps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
          {config.readPermissions.length > 0 && (
            <>
              <p className="mt-3 text-[12px] font-medium text-fg-dim">Set to Read</p>
              <ul className="mt-1.5 flex flex-wrap gap-1.5">
                {config.readPermissions.map((p) => (
                  <li key={p} className="rounded-md border border-hairline bg-bg-raised px-2 py-0.5 text-[12px] text-fg-muted">
                    {p}
                  </li>
                ))}
              </ul>
            </>
          )}
          <form
            className="mt-4 space-y-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (busy === null) void connect();
            }}
          >
            <label htmlFor={`${providerId}-restricted-key`} className="label">
              {config.inputLabel ?? "Restricted key"}
            </label>
            <input
              id={`${providerId}-restricted-key`}
              name={`${providerId}-restricted-key`}
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder={config.placeholder ?? "rk_live_…"}
              className="input w-full font-mono"
            />
            <p className="text-[12px] leading-4 text-fg-dim">
              {config.checkNote ??
                `OASIS checks the key with ${providerName} before saving it, then stores it encrypted. Full secret keys (sk_…) are refused.`}
            </p>
            <div className="flex gap-2 pt-1">
              <button type="submit" disabled={busy !== null || !key.trim()} className="btn-primary">
                {busy === "connect" ? `Checking with ${providerName}…` : hasConnection ? "Save new key" : `Connect ${providerName}`}
              </button>
              {replacing && (
                <button
                  type="button"
                  onClick={() => {
                    setReplacing(false);
                    setKey("");
                  }}
                  disabled={busy !== null}
                  className="btn-secondary"
                >
                  Cancel
                </button>
              )}
            </div>
          </form>
        </section>
      )}
    </div>
  );
}
