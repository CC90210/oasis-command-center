"use client";

/**
 * ServiceKeysForm — one app's saved keys, inside its ConnectorDrawer (Google
 * Workspace's sender, Twilio, the Telegram team bot).
 *
 * The app's card is the one place it is set up: this replaced the page-wide
 * "Business app keys" list that repeated every app under the grid. Fields come
 * from the store's own schema (lib/tenant-integration-schemas.ts), values go to
 * /api/integrations/keys, encrypted at rest and never returned — the page only
 * learns whether each field is set. Test posts to /api/integrations/keys/test,
 * which records the result the card's status is computed from, so the hub
 * re-reads every status afterwards (onChanged → router.refresh).
 *
 * Twilio: saved credentials are not a working sender. Texting stays off
 * ("Email-only") until the connection test passes; a messaging service can
 * stand in for the from-number.
 */

import { useCallback, useEffect, useState } from "react";
import { findTenantManuallyEditableIntegrationSchema } from "@/lib/tenant-integration-schemas";
import { relTime } from "@/lib/format-helpers";
import { Notice, type NoticeValue } from "@/components/os/connections/Notice";

type Row = {
  service: string;
  field_key: string;
  has_value: boolean;
  last_tested_at: string | null;
  last_test_ok: boolean | null;
  last_test_error: string | null;
  source?: "stored" | "environment" | null;
};

type Busy = "save" | "test" | "remove" | null;

async function send(method: "POST" | "DELETE", url: string, body: unknown) {
  const res = await fetch(url, {
    method,
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  const msg = typeof data?.message === "string" ? data.message : typeof data?.error === "string" ? data.error : `HTTP ${res.status}`;
  return { ok: res.ok && data?.ok !== false, data, msg };
}

export function ServiceKeysForm({
  service,
  appName,
  canManage,
  onChanged,
}: {
  service: string;
  appName: string;
  canManage: boolean;
  onChanged: () => void;
}) {
  const schema = findTenantManuallyEditableIntegrationSchema(service);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<Busy>(null);
  const [notice, setNotice] = useState<NoticeValue>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const reload = useCallback(async () => {
    try {
      const r = await fetch("/api/integrations/keys", { credentials: "include", cache: "no-store" });
      const j = (await r.json().catch(() => ({}))) as { ok?: boolean; rows?: Row[]; error?: string };
      if (r.ok && j.ok) {
        setRows((j.rows ?? []).filter((row) => row.service === service));
        setLoadError(null);
      } else {
        setLoadError(j.error || `HTTP ${r.status}`);
      }
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "network_error");
    }
  }, [service]);

  useEffect(() => {
    void reload();
  }, [reload]);

  if (!schema) return null;

  const row = (key: string) => rows?.find((r) => r.field_key === key) ?? null;
  const has = (key: string) => !!row(key)?.has_value;
  const allSet =
    service === "twilio"
      ? has("account_sid") && has("auth_token") && (has("from_number") || has("messaging_service_sid"))
      : schema.fields.every((f) => has(f.key));
  const tested = (rows ?? []).filter((r) => r.last_tested_at);
  const lastFail = tested.find((r) => r.last_test_ok === false) ?? null;
  const lastOk = tested.find((r) => r.last_test_ok === true) ?? null;
  const twilioVerified = service === "twilio" && allSet && !!lastOk && !lastFail;
  const stored = (rows ?? []).filter((r) => r.has_value && r.source !== "environment");
  const dirty = Object.values(drafts).some((v) => v.trim());

  const run = async (kind: Exclude<Busy, null>, action: () => Promise<void>) => {
    setBusy(kind);
    setNotice(null);
    try {
      await action();
    } catch (err) {
      console.error(`[connections.keys.${kind}]`, err);
      setNotice({ tone: "err", text: "Could not reach OASIS. Check your connection and try again." });
    } finally {
      setBusy(null);
    }
  };

  const save = () =>
    run("save", async () => {
      const entries = Object.entries(drafts).filter(([, v]) => v.trim());
      for (const [field_key, value] of entries) {
        const r = await send("POST", "/api/integrations/keys", { service, field_key, value });
        if (!r.ok) {
          const label = schema.fields.find((f) => f.key === field_key)?.label ?? field_key;
          setNotice({ tone: "err", text: `${label} was not saved: ${r.msg}` });
          await reload();
          onChanged();
          return;
        }
        setDrafts((d) => ({ ...d, [field_key]: "" }));
      }
      setNotice({ tone: "ok", text: "Saved." });
      await reload();
      onChanged();
    });

  const test = () =>
    run("test", async () => {
      const r = await send("POST", "/api/integrations/keys/test", { service });
      const detail = typeof r.data?.detail === "string" ? r.data.detail : null;
      setNotice(
        r.ok
          ? { tone: "ok", text: detail || `The check with ${appName} passed.` }
          : { tone: "err", text: `The check with ${appName} failed: ${r.msg}` },
      );
      await reload();
      onChanged();
    });

  const remove = () =>
    run("remove", async () => {
      for (const r of stored) {
        const res = await send("DELETE", "/api/integrations/keys", { service, field_key: r.field_key });
        if (!res.ok) {
          setNotice({ tone: "err", text: `Could not remove every saved value: ${res.msg}` });
          break;
        }
      }
      setConfirmRemove(false);
      await reload();
      onChanged();
    });

  return (
    <section className="space-y-4">
      <div>
        <h3 className="mb-1.5 text-xs font-medium text-fg-dim">{allSet ? `${appName} keys` : `Connect ${appName}`}</h3>
        <p className="text-[13px] leading-5 text-fg-muted">{schema.description}</p>
      </div>

      <Notice notice={notice} />

      {service === "twilio" && allSet && (
        <p className="text-[13px] leading-5 text-fg-muted">
          {twilioVerified
            ? "Account and sender are verified. Carrier registration and the live-send switch still control delivery."
            : "Email-only: the keys are saved, but texting stays off until Twilio passes Test."}
        </p>
      )}

      {lastFail ? (
        <p className="text-[12px] leading-4 text-status-hot">
          Last check failed{lastFail.last_test_error ? `: ${lastFail.last_test_error}` : ""} · {relTime(lastFail.last_tested_at)}
        </p>
      ) : lastOk ? (
        <p className="text-[12px] leading-4 text-fg-dim">Last check passed · {relTime(lastOk.last_tested_at)}</p>
      ) : null}

      {rows === null && !loadError ? (
        <p className="text-[13px] text-fg-dim">Loading…</p>
      ) : loadError ? (
        <p className="rounded-lg border border-status-warm/30 bg-status-warm/10 px-3 py-2 text-[13px] leading-5 text-fg">
          The saved keys could not be read ({loadError}), so nothing here is shown as set or missing. Refresh to try again.
        </p>
      ) : (
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (busy === null && dirty) void save();
          }}
        >
          {schema.fields.map((f) => {
            const r = row(f.key);
            const id = `${service}-${f.key}`;
            return (
              <div key={f.key} className="space-y-1">
                <label htmlFor={id} className="label flex items-baseline justify-between gap-2">
                  <span>{f.label}</span>
                  <span className="text-[11.5px] font-normal text-fg-dim">
                    {r?.has_value ? (r.source === "environment" ? "Set by OASIS" : "Saved") : "Not set"}
                  </span>
                </label>
                <input
                  id={id}
                  name={id}
                  type={f.sensitive ? "password" : "text"}
                  autoComplete="off"
                  spellCheck={false}
                  disabled={!canManage || busy !== null}
                  value={drafts[f.key] ?? ""}
                  onChange={(e) => setDrafts((d) => ({ ...d, [f.key]: e.target.value }))}
                  placeholder={r?.has_value ? "Saved. Paste a new value to replace it" : ""}
                  className={`input w-full ${f.sensitive ? "font-mono" : ""}`}
                />
                {f.hint && <p className="text-[12px] leading-4 text-fg-dim">{f.hint}</p>}
              </div>
            );
          })}
          <p className="text-[12px] leading-4 text-fg-dim">
            Stored encrypted. OASIS never shows a saved value again, only whether it is set.
          </p>
          {canManage ? (
            <div className="flex flex-wrap gap-2 pt-1">
              <button type="submit" disabled={busy !== null || !dirty} className="btn-primary">
                {busy === "save" ? "Saving…" : "Save"}
              </button>
              {allSet && (
                <button type="button" onClick={test} disabled={busy !== null} className="btn-secondary">
                  {busy === "test" ? `Checking with ${appName}…` : "Test"}
                </button>
              )}
              {stored.length > 0 && !confirmRemove && (
                <button type="button" onClick={() => setConfirmRemove(true)} disabled={busy !== null} className="btn-secondary">
                  Remove
                </button>
              )}
            </div>
          ) : (
            <p className="text-[13px] text-fg-muted">Only an owner or admin can change these keys.</p>
          )}
          {confirmRemove && (
            <div className="rounded-lg border border-hairline bg-bg-raised px-3 py-3">
              <p className="text-[13px] leading-5 text-fg">
                Remove the saved {appName} keys? Anything that uses {appName} stops until they are added again.
              </p>
              <div className="mt-3 flex gap-2">
                <button type="button" onClick={remove} disabled={busy !== null} className="btn-danger">
                  {busy === "remove" ? "Removing…" : "Remove"}
                </button>
                <button type="button" onClick={() => setConfirmRemove(false)} disabled={busy !== null} className="btn-secondary">
                  Cancel
                </button>
              </div>
            </div>
          )}
        </form>
      )}
    </section>
  );
}
