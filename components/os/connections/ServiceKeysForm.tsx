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
 * ONE VERDICT (2026-10-08). The form never judges the keys itself: the drawer's
 * Status above it is the card's own (lib/os/connectors.ts), and this form used
 * to print its own "Last check passed" / "Account and sender are verified" from
 * a different rule, under a card that said "not tested yet" for the same keys.
 * It shows only what each field holds, and says a Test result in plain words
 * (never the stored code).
 *
 * Twilio: a messaging service can stand in for the from-number, and an API key
 * for the Auth Token. Test runs as soon as the account and a credential are
 * saved, so "needs a number" is an answer the owner can read, not a missing
 * button. Texts leave only while live texting is switched on; a failed Test
 * does not stop them, and the form says so rather than promising it.
 */

import { useCallback, useEffect, useState } from "react";
import { findTenantManuallyEditableIntegrationSchema, requiredIntegrationFieldKeys } from "@/lib/tenant-integration-schemas";
import { Notice, type NoticeValue } from "@/components/os/connections/Notice";
import { testResultNotice } from "@/components/os/connections/test-notice";
import type { ConnectorStatus } from "@/lib/os/connectors";

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
  const ok = res.ok && data?.ok !== false;
  if (!ok) console.error("[connections.keys]", url, res.status, data?.error);
  return { ok, data, msg: plainFailure(res.status, data) };
}

/**
 * A refused request in plain words. A 422 carries the field check's own
 * sentence ("invalid email") or a written message; anything else is a code
 * meant for the logs, so the owner is told what to do instead.
 */
function plainFailure(status: number, data: Record<string, unknown> | null): string {
  if (typeof data?.message === "string" && data.message.trim()) return data.message;
  if (status === 422 && typeof data?.error === "string" && data.error.trim()) return data.error;
  if (status === 401) return "Your session ended. Sign in again, then retry.";
  if (status === 403) return "Only an owner or admin can change these keys.";
  return "OASIS could not finish that just now. Try again in a minute.";
}

/** "A", "A and B", "A, B and C". */
function listed(labels: readonly string[]): string {
  return labels.length <= 1 ? labels.join("") : `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}

/**
 * A save or a removal that stopped part way, field by field: each field is its
 * own request, so the ones before the failure did change. Says which did, which
 * failed and why, and which were not tried, never "nothing else changed".
 */
function partWay(verb: "saved" | "removed", done: readonly string[], failed: string, why: string, untried: readonly string[]): string {
  const were = (labels: readonly string[]) => (labels.length === 1 ? "was" : "were");
  return [
    done.length > 0 ? `${listed(done)} ${were(done)} ${verb}.` : "",
    `${failed} was not ${verb}: ${why}`,
    untried.length > 0 ? `${listed(untried)} ${were(untried)} not ${verb} either.` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

export function ServiceKeysForm({
  service,
  appName,
  canManage,
  onChanged,
  status,
}: {
  service: string;
  appName: string;
  canManage: boolean;
  onChanged: () => void;
  /** The card's own status (the drawer shows it above this form): the only verdict on these keys. */
  status: ConnectorStatus | null;
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
        console.error("[connections.keys.load]", r.status, j.error);
        setLoadError(r.status === 401 ? plainFailure(r.status, null) : "Refresh the page in a minute to try again.");
      }
    } catch (err) {
      console.error("[connections.keys.load]", err);
      setLoadError("OASIS could not be reached. Check your connection, then refresh the page.");
    }
  }, [service]);

  useEffect(() => {
    void reload();
  }, [reload]);

  if (!schema) return null;

  const row = (key: string) => rows?.find((r) => r.field_key === key) ?? null;
  const has = (key: string) => !!row(key)?.has_value;
  // Twilio: the Auth Token, or an API key with its secret; and a sender.
  const twilioCredential = has("account_sid") && (has("auth_token") || (has("api_key_sid") && has("api_key_secret")));
  // Every field the app needs; an optional one never holds back Test.
  const allSet =
    service === "twilio"
      ? twilioCredential && (has("from_number") || has("messaging_service_sid"))
      : requiredIntegrationFieldKeys(schema).every(has);
  // Twilio's test runs before a sender is saved: "needs a number" is its answer.
  const testable = service === "twilio" ? twilioCredential : allSet;
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

  const labelOf = (key: string) => schema.fields.find((f) => f.key === key)?.label ?? key;

  const save = () =>
    run("save", async () => {
      const entries = Object.entries(drafts).filter(([, v]) => v.trim());
      const saved: string[] = [];
      for (const [i, [field_key, value]] of entries.entries()) {
        const r = await send("POST", "/api/integrations/keys", { service, field_key, value });
        if (!r.ok) {
          const untried = entries.slice(i + 1).map(([key]) => labelOf(key));
          setNotice({ tone: "err", text: partWay("saved", saved, labelOf(field_key), r.msg, untried) });
          await reload();
          onChanged();
          return;
        }
        saved.push(labelOf(field_key));
        setDrafts((d) => ({ ...d, [field_key]: "" }));
      }
      setNotice({ tone: "ok", text: "Saved." });
      await reload();
      onChanged();
    });

  const test = () =>
    run("test", async () => {
      const r = await send("POST", "/api/integrations/keys/test", { service });
      // What the check found, in the card's own words (test-notice.ts). The
      // result is saved where the card reads it, so the Status above shows it
      // after this re-read; when it could not be saved, the notice says so.
      setNotice(testResultNotice({ service, appName, ok: r.ok, data: r.data, requestFailure: r.msg }));
      await reload();
      onChanged();
    });

  const remove = () =>
    run("remove", async () => {
      const removed: string[] = [];
      try {
        for (const [i, r] of stored.entries()) {
          const res = await send("DELETE", "/api/integrations/keys", { service, field_key: r.field_key });
          if (!res.ok) {
            const untried = stored.slice(i + 1).map((x) => labelOf(x.field_key));
            setNotice({ tone: "err", text: partWay("removed", removed, labelOf(r.field_key), res.msg, untried) });
            break;
          }
          removed.push(labelOf(r.field_key));
        }
      } finally {
        // Some fields may be gone even when a later one failed: always re-read,
        // so nothing removed is still shown as saved.
        setConfirmRemove(false);
        await reload();
        onChanged();
      }
    });

  return (
    <section className="space-y-4">
      <div>
        <h3 className="mb-1.5 text-xs font-medium text-fg-dim">{allSet ? `${appName} keys` : `Connect ${appName}`}</h3>
        <p className="text-[13px] leading-5 text-fg-muted">{schema.description}</p>
        {schema.getKey && (
          <p className="mt-1.5 text-[13px] leading-5">
            <a href={schema.getKey.href} target="_blank" rel="noopener noreferrer" className="text-accent underline-offset-2 hover:underline">
              {schema.getKey.label}
            </a>
          </p>
        )}
      </div>

      <Notice notice={notice} />

      {service === "twilio" && allSet && (
        <p className="text-[13px] leading-5 text-fg-muted">
          {status?.kind === "connected"
            ? "The account and sender passed Test. Carrier registration and the live-send switch still decide whether a text is delivered."
            : "Texts go out only while live texting is switched on, and a failed Test does not stop them: run Test and fix what it finds before switching it on."}
        </p>
      )}

      {rows === null && !loadError ? (
        <p className="text-[13px] text-fg-dim">Loading…</p>
      ) : loadError ? (
        <p className="rounded-lg border border-status-warm/30 bg-status-warm/10 px-3 py-2 text-[13px] leading-5 text-fg">
          The saved keys could not be read, so nothing here is shown as set or missing. {loadError}
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
                  placeholder={r?.has_value ? "Saved. Paste a new value to replace it" : f.placeholder ?? ""}
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
              {testable && (
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
