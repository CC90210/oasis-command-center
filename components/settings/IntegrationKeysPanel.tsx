"use client";

/**
 * IntegrationKeysPanel — the paste-and-save card on /settings for
 * per-tenant integration credentials. Reads /api/integrations/keys
 * for status, POSTs new values, DELETEs to clear, and POSTs /test
 * to live-probe each integration.
 *
 * Each integration renders one row per field defined in
 * lib/tenant-integration-store.ts INTEGRATION_SCHEMAS. Values are
 * write-only — the API never returns plaintext or ciphertext, only
 * "has_value: true/false" + last test result.
 */

import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, AlertCircle, KeyRound, Trash2, Loader2 } from "lucide-react";
import { Card } from "@/components/Card";
import { TENANT_MANUALLY_EDITABLE_INTEGRATION_SCHEMAS } from "@/lib/tenant-integration-schemas";
import { relTime } from "@/lib/format-helpers";

type StatusRow = {
  service: string;
  field_key: string;
  has_value: boolean;
  last_tested_at: string | null;
  last_test_ok: boolean | null;
  last_test_error: string | null;
  source?: "stored" | "environment" | null;
};

type Drafts = Record<string, string>; // key: `${service}::${field_key}`
type Saving = Record<string, boolean>;
type LastError = Record<string, string | null>;

function k(service: string, fieldKey: string): string {
  return `${service}::${fieldKey}`;
}

// relTime moved to lib/format-helpers (shared with LeadTimelinePanel +
// LeadDetailDrawer header). Single source of truth for the
// "5m ago / 2h ago / 3d ago" shape.

export function IntegrationKeysPanel({
  canManage,
}: {
  canManage: boolean;
}) {
  const [status, setStatus] = useState<StatusRow[]>([]);
  const [drafts, setDrafts] = useState<Drafts>({});
  const [saving, setSaving] = useState<Saving>({});
  const [errors, setErrors] = useState<LastError>({});
  const [testing, setTesting] = useState<Record<string, boolean>>({});
  const [testResults, setTestResults] = useState<
    Record<string, { ok: boolean; detail: string | null; error: string | null }>
  >({});
  const [loaded, setLoaded] = useState(false);
  // 2026-06-08: rows with `advanced: true` on their schema are hidden by
  // default. Most operators want Gmail not SMTP, etc. When this is true,
  // the panel also renders the rows tagged advanced (SMTP, etc.).
  const [showAdvanced, setShowAdvanced] = useState(false);

  const [loadError, setLoadError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const r = await fetch("/api/integrations/keys", { credentials: "include" });
      const j = await r.json().catch(() => ({}));
      if (r.ok && j.ok) {
        setStatus(j.rows || []);
        setLoadError(null);
      } else {
        // Most common cause pre-deploy: migration 058 hasn't been
        // applied yet, so the table doesn't exist. Surface the
        // diagnostic inline so the operator sees what to do instead
        // of staring at an indefinite "Loading…" spinner.
        setLoadError(j.error || `http ${r.status}`);
      }
    } catch (e) {
      setLoadError((e as Error).message || "network_error");
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const statusFor = (service: string, fieldKey: string) =>
    status.find((s) => s.service === service && s.field_key === fieldKey) || null;

  const save = async (service: string, fieldKey: string) => {
    const key = k(service, fieldKey);
    const value = drafts[key] || "";
    if (!value.trim()) return;
    setSaving((s) => ({ ...s, [key]: true }));
    setErrors((e) => ({ ...e, [key]: null }));
    try {
      const r = await fetch("/api/integrations/keys", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ service, field_key: fieldKey, value }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) {
        setErrors((e) => ({ ...e, [key]: j.error || `save_failed_${r.status}` }));
      } else {
        setDrafts((d) => ({ ...d, [key]: "" }));
        await reload();
      }
    } catch (err) {
      setErrors((e) => ({ ...e, [key]: String((err as Error).message || err) }));
    } finally {
      setSaving((s) => ({ ...s, [key]: false }));
    }
  };

  const clear = async (service: string, fieldKey: string) => {
    const key = k(service, fieldKey);
    if (!confirm(`Clear ${service} → ${fieldKey}? This removes the stored value.`)) return;
    setSaving((s) => ({ ...s, [key]: true }));
    try {
      const r = await fetch("/api/integrations/keys", {
        method: "DELETE",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ service, field_key: fieldKey }),
      });
      if (r.ok) await reload();
    } finally {
      setSaving((s) => ({ ...s, [key]: false }));
    }
  };

  const test = async (service: string) => {
    setTesting((t) => ({ ...t, [service]: true }));
    setTestResults((results) => {
      const next = { ...results };
      delete next[service];
      return next;
    });
    try {
      const r = await fetch("/api/integrations/keys/test", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ service }),
      });
      const body = (await r.json().catch(() => ({}))) as {
        ok?: boolean;
        detail?: string | null;
        error?: string | null;
      };
      setTestResults((results) => ({
        ...results,
        [service]: {
          ok: r.ok && body.ok === true,
          detail: typeof body.detail === "string" ? body.detail : null,
          error:
            typeof body.error === "string"
              ? body.error
              : r.ok
                ? "test_failed"
                : `http_${r.status}`,
        },
      }));
      await reload();
    } catch (error) {
      setTestResults((results) => ({
        ...results,
        [service]: {
          ok: false,
          detail: null,
          error: error instanceof Error ? error.message : "network_error",
        },
      }));
    } finally {
      setTesting((t) => ({ ...t, [service]: false }));
    }
  };

  return (
    <Card>
      <div className="flex items-start justify-between mb-3 gap-3">
        <div>
          <h3 className="text-sm font-bold text-fg flex items-center gap-2">
            <KeyRound className="w-4 h-4" />
            Business app keys
          </h3>
          <p className="text-[11.5px] text-fg-muted leading-relaxed mt-1">
            Outbound channels your agents use to reach leads — Twilio (SMS),
            Gmail / SMTP (email), TextTorrent, n8n, Stripe, Telegram. Distinct
            from AI provider keys above (those power the agents&apos; reasoning;
            these power what they send out). Values are encrypted at rest
            (AES-256-GCM) and decrypted only inside server-side send paths —
            never returned to the browser. The Integration health card lower
            on this page is status-only; this is where credentials are saved.
          </p>
        </div>
      </div>

      {!canManage && (
        <div className="rounded-md border border-amber-300/30 bg-amber-300/10 p-3 text-xs text-amber-200 mb-3">
          Read-only — only tenant owners and admins can change integration keys.
        </div>
      )}

      {!loaded ? (
        <div className="text-xs text-fg-dim italic py-3 text-center">Loading…</div>
      ) : loadError ? (
        <div className="rounded-md border border-amber-300/30 bg-amber-300/10 p-3 text-xs text-amber-200 leading-relaxed">
          <div className="font-semibold mb-1">Integration store not initialised</div>
          <div className="font-mono text-[10.5px] text-amber-200/80 break-all">
            {loadError}
          </div>
          <div className="mt-1.5 text-amber-200/80">
            Apply migration 058 to enable paste-and-save:{" "}
            <code className="text-amber-100">
              python scripts/apply_migration.py database/058_tenant_integration_credentials.sql
            </code>
          </div>
        </div>
      ) : (
        <div className="space-y-5">
          {TENANT_MANUALLY_EDITABLE_INTEGRATION_SCHEMAS.filter(
            (s) => !s.advanced || showAdvanced,
          ).map((schema) => {
            const fieldStatuses = schema.fields.map((f) => ({
              field: f,
              status: statusFor(schema.service, f.key),
            }));
            const allSet = schema.service === "twilio"
              ? Boolean(
                  statusFor("twilio", "account_sid")?.has_value &&
                  statusFor("twilio", "auth_token")?.has_value &&
                  (
                    statusFor("twilio", "from_number")?.has_value ||
                    statusFor("twilio", "messaging_service_sid")?.has_value
                  ),
                )
              : fieldStatuses.every((fs) => fs.status?.has_value);
            const anyTested = fieldStatuses.some((fs) => fs.status?.last_tested_at);
            const lastTestOk = fieldStatuses.find(
              (fs) => fs.status?.last_test_ok === true,
            );
            const lastTestFail = fieldStatuses.find(
              (fs) => fs.status?.last_test_ok === false,
            );
            const twilioVerified =
              schema.service === "twilio" && allSet && Boolean(lastTestOk) && !lastTestFail;

            return (
              <div
                key={schema.service}
                className="rounded-md border border-bg-border bg-bg-deep/40 p-3"
              >
                <div className="flex items-start justify-between gap-3 mb-2">
                  <div className="min-w-0">
                    <div className="text-[13px] font-semibold text-fg flex items-center gap-2">
                      {schema.label}
                      {allSet && lastTestOk && (
                        <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                      )}
                      {lastTestFail && (
                        <AlertCircle className="w-3.5 h-3.5 text-red-400" />
                      )}
                      {schema.service === "twilio" && (
                        <span
                          className={
                            twilioVerified
                              ? "rounded border border-emerald-500/30 bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-bold text-emerald-300"
                              : "rounded border border-amber-500/30 bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-bold text-amber-300"
                          }
                        >
                          {twilioVerified ? "Credentials verified" : "Email-only"}
                        </span>
                      )}
                      {schema.service !== "twilio" && allSet && !lastTestOk && !lastTestFail && (
                        <span className="rounded border border-sky-500/30 bg-sky-500/10 px-1.5 py-0.5 text-[10px] font-bold text-sky-300">
                          Configured
                        </span>
                      )}
                    </div>
                    <div className="text-[11px] text-fg-muted leading-relaxed mt-0.5">
                      {schema.description}
                    </div>
                    {schema.service === "twilio" && allSet && !twilioVerified && (
                      <div className="mt-1 text-[10.5px] leading-relaxed text-amber-300">
                        Credentials are saved, but SMS remains unavailable until Twilio passes Test.
                      </div>
                    )}
                    {twilioVerified && (
                      <div className="mt-1 text-[10.5px] leading-relaxed text-fg-dim">
                        Account and sender are verified. Carrier registration and the live-send switch still control delivery.
                      </div>
                    )}
                  </div>
                  {allSet && (
                    <button
                      type="button"
                      disabled={testing[schema.service]}
                      onClick={() => test(schema.service)}
                      className="shrink-0 text-[11px] uppercase tracking-wider px-2 py-1 rounded-md border border-bg-border text-fg-muted hover:text-fg disabled:opacity-50 inline-flex items-center gap-1"
                    >
                      {testing[schema.service] && (
                        <Loader2 className="w-3 h-3 animate-spin" />
                      )}
                      {testing[schema.service] ? "Testing…" : "Test"}
                    </button>
                  )}
                </div>

                {anyTested && (
                  <div className="text-[11px] mb-2">
                    {lastTestFail ? (
                      <span className="text-red-300">
                        Last test failed · {lastTestFail.status?.last_test_error || "unknown"} ·{" "}
                        {relTime(lastTestFail.status?.last_tested_at || null)}
                      </span>
                    ) : lastTestOk ? (
                      <span className="text-emerald-300">
                        Verified · {relTime(lastTestOk.status?.last_tested_at || null)}
                      </span>
                    ) : null}
                  </div>
                )}

                {testResults[schema.service] && (
                  <div
                    role="status"
                    className={`mb-2 text-[11px] ${
                      testResults[schema.service].ok ? "text-emerald-300" : "text-red-300"
                    }`}
                  >
                    {testResults[schema.service].ok
                      ? testResults[schema.service].detail || "Connection test passed."
                      : `Connection test failed · ${testResults[schema.service].error || "unknown_error"}`}
                  </div>
                )}

                <div className="space-y-2">
                  {fieldStatuses.map(({ field, status: fStatus }) => {
                    const key = k(schema.service, field.key);
                    const hasValue = !!fStatus?.has_value;
                    return (
                      <div key={field.key} className="grid gap-1.5">
                        <label className="text-[10.5px] uppercase tracking-wider text-fg-muted">
                          {field.label}
                          {hasValue ? (
                            <span className="ml-1.5 text-emerald-400 normal-case">
                              · {fStatus?.source === "environment" ? "configured in deployment" : "saved"}
                            </span>
                          ) : (
                            <span className="ml-1.5 text-fg-dim normal-case">· not set</span>
                          )}
                        </label>
                        {field.hint && (
                          <div className="text-[10.5px] text-fg-dim leading-relaxed">{field.hint}</div>
                        )}
                        <div className="flex items-center gap-2">
                          <input
                            type={field.sensitive ? "password" : "text"}
                            value={drafts[key] || ""}
                            disabled={!canManage}
                            placeholder={hasValue ? "•••••••• (paste to replace)" : "Paste value here"}
                            onChange={(e) =>
                              setDrafts((d) => ({ ...d, [key]: e.target.value }))
                            }
                            className="flex-1 text-xs px-2 py-1.5 rounded-md bg-bg-elev border border-bg-border text-fg placeholder:text-fg-dim/60 disabled:opacity-50"
                          />
                          <button
                            type="button"
                            disabled={!canManage || saving[key] || !(drafts[key] || "").trim()}
                            onClick={() => save(schema.service, field.key)}
                            className="text-[11px] font-semibold px-2.5 py-1.5 rounded-md bg-accent text-bg-deep disabled:opacity-50"
                          >
                            {saving[key] ? "Saving…" : "Save"}
                          </button>
                          {hasValue && canManage && (
                            <button
                              type="button"
                              disabled={saving[key]}
                              onClick={() => clear(schema.service, field.key)}
                              aria-label={`Clear ${field.label}`}
                              className="p-1.5 rounded-md text-fg-muted hover:text-red-300 hover:bg-red-500/10 disabled:opacity-50"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </div>
                        {errors[key] && (
                          <div className="text-[10.5px] text-red-300">{errors[key]}</div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
          {/* Show advanced toggle — reveals SMTP and other edge-case
              integrations that most operators don't need. Keeps the
              default view clean while still letting power users find
              the option. */}
          {TENANT_MANUALLY_EDITABLE_INTEGRATION_SCHEMAS.some((s) => s.advanced) && (
            <button
              type="button"
              onClick={() => setShowAdvanced((v) => !v)}
              className="text-[11px] text-fg-muted hover:text-fg inline-flex items-center gap-1 pl-1"
            >
              {showAdvanced ? "Hide" : "Show"} advanced integrations (SMTP, etc.)
            </button>
          )}
        </div>
      )}
    </Card>
  );
}
