"use client";

/**
 * QuickInviteCard — inline invite-mint affordance for the Settings page.
 *
 * The Settings card has a "Manage team & invites →" link to /team for
 * the full mint/revoke/list UI. This component uses the SAME server-resolved
 * email + role contract as /team, so Settings cannot drift into a second role
 * model or mint an unpinned bearer link. After mint, it shows the URL with a
 * Copy button.
 *
 * Heavy lifting (active invite list and revoke) stays at /team.
 */

import { useEffect, useState } from "react";
import { Check, Copy, Loader2, Link as LinkIcon, AlertCircle } from "lucide-react";
import {
  isInvitableRole,
  type InvitableRole,
  type RoleOption,
} from "@/lib/team-roles";

export function QuickInviteCard() {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<InvitableRole | null>(null);
  const [roleOptions, setRoleOptions] = useState<readonly RoleOption[]>([]);
  const [rolesLoading, setRolesLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [issuedUrl, setIssuedUrl] = useState<string | null>(null);
  const [issuedExpiry, setIssuedExpiry] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const normalizedEmail = email.trim().toLowerCase();
  const emailIsValid =
    normalizedEmail.length <= 254 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail);
  const selectedRole = roleOptions.find((option) => option.value === role);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const res = await fetch("/api/team/invites", { cache: "no-store" });
        const data = await res.json();
        if (!res.ok || !data.ok || !Array.isArray(data.role_options)) {
          throw new Error(data.error || "Invite roles are unavailable.");
        }
        const options = data.role_options.filter(
          (option: unknown): option is RoleOption => {
            if (!option || typeof option !== "object") return false;
            const row = option as Record<string, unknown>;
            return (
              isInvitableRole(row.value) &&
              typeof row.label === "string" &&
              typeof row.description === "string"
            );
          },
        );
        if (options.length === 0) throw new Error("No invite roles are available.");
        if (!active) return;
        setRoleOptions(options);
        setRole(options[0].value);
      } catch (err) {
        if (active) {
          setError(err instanceof Error ? err.message : "Invite roles are unavailable.");
        }
      } finally {
        if (active) setRolesLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  async function generate() {
    setBusy(true);
    setError(null);
    setIssuedUrl(null);
    setCopied(false);
    if (!emailIsValid) {
      setError("Enter the teammate's valid work email.");
      setBusy(false);
      return;
    }
    if (!role || !roleOptions.some((option) => option.value === role)) {
      setError("Choose an available role.");
      setBusy(false);
      return;
    }
    try {
      const res = await fetch("/api/team/invites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role, email: normalizedEmail }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok || !data.invite?.raw_token) {
        setError(data.error || `Failed to create invite (http_${res.status}).`);
        return;
      }
      const url = `${window.location.origin}/invite/${data.invite.raw_token}`;
      setIssuedUrl(url);
      setIssuedExpiry(data.invite.expires_at);
      setEmail("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create invite.");
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (!issuedUrl) return;
    try {
      await navigator.clipboard.writeText(issuedUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      window.prompt("Copy this URL:", issuedUrl);
    }
  }

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 items-end gap-3 md:grid-cols-[1fr_14rem_auto]">
        <label>
          <span className="block text-[11px] uppercase tracking-wider text-fg-dim font-bold mb-1">
            Work email
          </span>
          <input
            type="email"
            required
            maxLength={254}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            disabled={busy}
            placeholder="teammate@company.com"
            className="w-full rounded-md border border-bg-border bg-bg-elev px-3 py-2 text-sm text-fg disabled:opacity-50"
          />
        </label>
        <label>
          <span className="block text-[11px] uppercase tracking-wider text-fg-dim font-bold mb-1">
            Role
          </span>
          <select
            value={role ?? ""}
            onChange={(e) => {
              if (isInvitableRole(e.target.value)) setRole(e.target.value);
            }}
            disabled={busy || rolesLoading}
            className="w-full rounded-md border border-bg-border bg-bg-elev px-3 py-2 text-sm text-fg disabled:opacity-50"
          >
            {roleOptions.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
          {selectedRole && (
            <span className="mt-1 block text-[11px] leading-4 text-fg-dim">
              {selectedRole.description}
            </span>
          )}
        </label>
        <button
          type="button"
          onClick={generate}
          disabled={busy || rolesLoading || !emailIsValid || !role}
          className="inline-flex items-center gap-2 rounded-lg bg-accent text-bg-deep px-4 py-2 text-sm font-bold hover:bg-accent-bright disabled:opacity-50"
        >
          {busy ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <LinkIcon className="w-4 h-4" />
          )}
          Generate link
        </button>
      </div>

      {issuedUrl && (
        <div className="rounded-md border border-status-engaged/40 bg-status-engaged/10 p-3 space-y-2">
          <div className="text-xs text-status-engaged font-bold">
            Invite link ready{" "}
            {issuedExpiry && (
              <span className="text-fg-dim font-normal">
                — expires {new Date(issuedExpiry).toLocaleDateString()}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <code className="flex-1 rounded-md bg-bg-deep border border-bg-border px-2 py-1.5 font-mono text-[11px] text-fg-muted overflow-x-auto whitespace-nowrap">
              {issuedUrl}
            </code>
            <button
              type="button"
              onClick={copy}
              className="inline-flex items-center gap-1 rounded-md border border-bg-border bg-bg-elev px-2.5 py-1.5 text-xs font-bold text-fg hover:border-accent/40"
            >
              {copied ? (
                <>
                  <Check className="w-3 h-3 text-status-engaged" />
                  Copied
                </>
              ) : (
                <>
                  <Copy className="w-3 h-3" />
                  Copy
                </>
              )}
            </button>
          </div>
        </div>
      )}

      {error && (
        <div className="flex items-start gap-2 text-xs text-rose-400">
          <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}
    </div>
  );
}
