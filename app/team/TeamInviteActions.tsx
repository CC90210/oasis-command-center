"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { isInvitableRole, teamRoleLabel, type RoleOption } from "@/lib/team-roles";

type ActiveInvite = {
  id: string;
  email: string | null;
  team_role: string;
  expires_at: string;
};


export function TeamInviteActions({
  activeInvites,
  roleOptions,
}: {
  activeInvites: ActiveInvite[];
  /**
   * Which roles this WORKSPACE may hand out, resolved on the server by
   * invitableRoleOptionsFor(tenantSlug). Passed in rather than imported so the
   * client never has to know the tenant rules — and so the menu can never offer
   * a role the API would reject.
   */
  roleOptions: readonly RoleOption[];
}) {
  const router = useRouter();
  const [role, setRole] = useState(roleOptions[0]?.value ?? "member");
  const [email, setEmail] = useState("");
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [issuedUrl, setIssuedUrl] = useState<string | null>(null);
  const [issuedExpiry, setIssuedExpiry] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [emailSent, setEmailSent] = useState<boolean | null>(null);
  const [superseded, setSuperseded] = useState(0);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const normalizedEmail = email.trim().toLowerCase();
  const emailIsValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)
    && normalizedEmail.length <= 254;
  const selectedRole = roleOptions.find((option) => option.value === role);

  async function sendInvite() {
    if (busy) return;
    setError(null);
    setIssuedUrl(null);
    setEmailSent(null);
    setSentTo(null);
    setSuperseded(0);
    setCopied(false);
    if (!emailIsValid) {
      setError("Enter the teammate's valid work email.");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/team/invites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role, email: normalizedEmail }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setError(data.error || "Failed to create invite.");
        return;
      }
      if (typeof data.invite?.invite_url !== "string") {
        setError("The invite was created, but its delivery receipt was incomplete.");
        return;
      }
      setIssuedUrl(data.invite.invite_url);
      setIssuedExpiry(data.invite.expires_at);
      setEmailSent(data.invite.email_sent === true);
      setSentTo(normalizedEmail);
      setSuperseded(Number(data.invite.superseded) || 0);
      setEmail("");
      startTransition(() => router.refresh());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create invite.");
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    if (!confirm("Revoke this invite?")) return;
    const res = await fetch(`/api/team/invites/${id}`, { method: "DELETE" });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      alert(data.error || "Revoke failed.");
      return;
    }
    startTransition(() => router.refresh());
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-3 items-end md:grid-cols-[1fr_14rem_8rem]">
        <label className="block">
          <span className="text-xs uppercase tracking-wider text-fg-dim">
            Work email
          </span>
          <input
            type="email"
            required
            maxLength={254}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="teammate@company.com"
            className="mt-1 w-full bg-bg-elevated text-fg border border-bg-border rounded px-3 py-2 text-sm focus:outline-none focus:border-accent"
          />
        </label>
        <label className="block">
          <span className="text-xs uppercase tracking-wider text-fg-dim">Role</span>
          <select
            value={role}
            // Narrowed, not cast. A <select> hands back a plain string, and a
            // tampered option value would otherwise land straight in state. The
            // server re-validates regardless — this keeps the client honest too.
            onChange={(e) => {
              if (isInvitableRole(e.target.value)) setRole(e.target.value);
            }}
            className="mt-1 w-full bg-bg-elevated text-fg border border-bg-border rounded px-3 py-2 text-sm"
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
          onClick={sendInvite}
          disabled={pending || busy || !emailIsValid}
          className="bg-accent text-bg font-semibold py-2 px-3 rounded text-sm hover:opacity-90 disabled:opacity-50"
        >
          {busy ? "Sending..." : "Send invite email"}
        </button>
      </div>

      {error && (
        <div className="text-sm text-status-attention bg-bg-elevated border border-bg-border rounded px-3 py-2">
          {error}
        </div>
      )}

      {issuedUrl && emailSent === true && (
        <div className="rounded border border-status-engaged/40 bg-status-engaged/10 p-3 space-y-2">
          <div className="text-sm font-semibold text-status-engaged">
            Invite email sent to {sentTo}.
          </div>
          <div className="text-xs text-fg-muted">
            The one-time link expires{" "}
            {issuedExpiry ? new Date(issuedExpiry).toLocaleString() : "in 7 days"}.
            {superseded > 0 ? " An earlier link for this person was revoked." : ""}
          </div>
          <button
            type="button"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(issuedUrl);
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              } catch {
                setCopied(false);
              }
            }}
            className="text-xs text-fg-muted underline underline-offset-2 hover:text-fg"
          >
            {copied ? "Backup link copied" : "Copy backup link"}
          </button>
        </div>
      )}

      {issuedUrl && emailSent === false && (
        <div className="rounded border border-status-attention/40 bg-status-attention/10 p-3 space-y-2">
          <div className="text-sm font-semibold text-status-attention">
            Email delivery failed. The invite is valid; send this backup link to {sentTo}.
          </div>
          <div className="text-xs uppercase tracking-wider text-accent font-mono">
            Backup delivery link
          </div>
          <div className="flex items-center gap-2">
            <input
              readOnly
              value={issuedUrl}
              className="flex-1 bg-bg text-fg border border-bg-border rounded px-2 py-1.5 text-xs font-mono"
              onFocus={(e) => e.currentTarget.select()}
            />
            <button
              type="button"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(issuedUrl);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                } catch {
                  setCopied(false);
                }
              }}
              className="bg-bg-elevated border border-bg-border text-fg text-xs py-1.5 px-3 rounded hover:border-accent"
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <div className="text-xs text-fg-muted">
            Expires{" "}
            {issuedExpiry
              ? new Date(issuedExpiry).toLocaleString()
              : "in 7 days"}
            . This backup is shown only because email delivery failed.
          </div>
        </div>
      )}

      {activeInvites.length > 0 && (
        <div className="pt-2">
          <div className="text-xs uppercase tracking-wider text-fg-dim mb-2">
            Active invites
          </div>
          <ul className="divide-y divide-bg-border">
            {activeInvites.map((inv) => (
              <li
                key={inv.id}
                className="grid grid-cols-[1fr_8rem_8rem_5rem] gap-3 py-2 items-center"
              >
                <span className="text-sm text-fg">
                  {inv.email || "(invalid legacy invite)"}
                </span>
                <span className="text-sm text-fg-muted">{teamRoleLabel(inv.team_role)}</span>
                <span className="text-xs text-fg-dim">
                  expires {new Date(inv.expires_at).toLocaleDateString()}
                </span>
                <button
                  type="button"
                  onClick={() => revoke(inv.id)}
                  className="text-xs text-fg-muted hover:text-fg underline-offset-2 hover:underline"
                >
                  Revoke
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/**
 * Per-member full-admin toggle. Rendered ONLY for true admins (owner/admin) on
 * NON-owner members — the parent server page gates visibility. PATCHes
 * /api/team/members/<id>/admin-access and reflects the current grant state.
 * Admin-toggle design, 2026-07-07.
 */
export function AdminAccessToggle({
  profileId,
  initialGranted,
}: {
  profileId: string;
  initialGranted: boolean;
}) {
  const router = useRouter();
  const [granted, setGranted] = useState(initialGranted);
  const [busy, setBusy] = useState(false);
  const [pending, startTransition] = useTransition();

  async function toggle() {
    const next = !granted;
    setBusy(true);
    try {
      const res = await fetch(
        `/api/team/members/${encodeURIComponent(profileId)}/admin-access`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ admin_access: next }),
        }
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        alert(data.error || "Update failed.");
        return;
      }
      setGranted(next);
      startTransition(() => router.refresh());
    } catch (err) {
      alert(err instanceof Error ? err.message : "Update failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={toggle}
      disabled={busy || pending}
      title={granted ? "Revoke full admin access" : "Grant full admin access"}
      className={`text-[11px] font-mono px-2 py-1 rounded border transition-colors disabled:opacity-50 ${
        granted
          ? "border-accent/50 bg-accent/10 text-accent hover:bg-accent/20"
          : "border-bg-border text-fg-muted hover:text-fg hover:border-accent/40"
      }`}
    >
      {busy ? "..." : granted ? "Admin: on" : "Admin: off"}
    </button>
  );
}

export function RemoveMemberClientButton({ profileId }: { profileId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  async function remove() {
    if (!confirm("Remove this member from the tenant?")) return;
    const res = await fetch(
      `/api/team/members?profile_id=${encodeURIComponent(profileId)}`,
      { method: "DELETE" }
    );
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      alert(data.error || "Remove failed.");
      return;
    }
    startTransition(() => router.refresh());
  }

  return (
    <button
      type="button"
      onClick={remove}
      disabled={pending}
      className="text-xs text-fg-muted hover:text-fg underline-offset-2 hover:underline disabled:opacity-50"
    >
      {pending ? "..." : "Remove"}
    </button>
  );
}
