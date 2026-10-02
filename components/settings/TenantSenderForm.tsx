"use client";

/**
 * Settings > Brand: the form where a workspace's owner or admin registers the
 * identity its email goes out under (saveSenderIdentity, the Brand page's
 * server action in app/settings/brand/actions.ts).
 *
 * The status line is what the server found, never a guess made here: the page
 * renders it from the live mailbox check, and a save replaces it with the
 * check that save ran. When the address is not verified yet the line says
 * exactly what is missing and links to the Google Workspace connection.
 *
 * The footer preview shows the lines every email from this workspace will end
 * with, built from the fields as typed, so the owner sees what the law asks
 * them to supply and where it goes.
 */

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { StatusLine } from "@/components/os/connections/StatusLine";
import { saveSenderIdentity } from "@/app/settings/brand/actions";

export type SenderFormValues = {
  display_name: string;
  legal_name: string;
  postal_address: string;
  from_address: string;
  reply_to: string;
};

export type SenderFormStatus = {
  kind: "connected" | "attention" | "not_connected" | "unknown";
  label: string;
  detail: string;
};

type Field = keyof SenderFormValues;

export function TenantSenderForm({
  initial,
  status: initialStatus,
  connectHref,
  disabled = false,
}: {
  initial: SenderFormValues;
  status: SenderFormStatus;
  /** Settings > Connections with the Google Workspace drawer open. */
  connectHref: string;
  /** The identity could not be read: saving now could overwrite it unseen. */
  disabled?: boolean;
}) {
  const router = useRouter();
  const [values, setValues] = useState<SenderFormValues>(initial);
  const [status, setStatus] = useState<SenderFormStatus>(initialStatus);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<{ message: string; field: Field | null } | null>(null);

  const set = (key: Field) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    setValues((v) => ({ ...v, [key]: e.target.value }));
    setSaved(null);
  };

  async function onSave(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setSaved(null);
    setError(null);
    try {
      const result = await saveSenderIdentity(values);
      if (!result.ok) {
        setError({ message: result.message, field: result.field ?? null });
        return;
      }
      setStatus(result.status);
      setSaved("Saved.");
      router.refresh();
    } catch {
      setError({ message: "The sending identity couldn't be saved. Check your connection and try again.", field: null });
    } finally {
      setBusy(false);
    }
  }

  const invalid = (key: Field) => (error?.field === key ? true : undefined);
  const contact = (values.reply_to.trim() || values.from_address.trim()).toLowerCase();
  const postalPreview = values.postal_address
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(", ");

  return (
    <form onSubmit={onSave} className="space-y-5" noValidate>
      <div className="space-y-1">
        <StatusLine status={status} />
        <p className="text-[13px] leading-5 text-fg-muted">{status.detail}</p>
        {status.kind !== "connected" && !disabled && (
          <Link href={connectHref} prefetch={false} className="text-[13px] text-accent hover:underline">
            Open Google Workspace in Connections
          </Link>
        )}
      </div>

      <fieldset disabled={disabled || busy} className="grid gap-4 sm:grid-cols-2">
        <label className="block">
          <span className="label">Business name</span>
          <input className="input" value={values.display_name} onChange={set("display_name")} maxLength={80} aria-invalid={invalid("display_name")} placeholder="e.g. Acme Plumbing" />
          <span className="mt-1 block text-xs text-fg-dim">Shown as the sender, in front of the email address.</span>
        </label>
        <label className="block">
          <span className="label">Legal business name</span>
          <input className="input" value={values.legal_name} onChange={set("legal_name")} maxLength={160} aria-invalid={invalid("legal_name")} placeholder="e.g. Acme Plumbing Inc." />
          <span className="mt-1 block text-xs text-fg-dim">As registered. It is printed at the bottom of every email.</span>
        </label>
        <label className="block sm:col-span-2">
          <span className="label">Postal address</span>
          <textarea className="textarea" rows={2} value={values.postal_address} onChange={set("postal_address")} maxLength={320} aria-invalid={invalid("postal_address")} placeholder="Street and number or PO box, city, province or state, postal code" />
          <span className="mt-1 block text-xs text-fg-dim">
            Required. Anti-spam law (CASL in Canada, CAN-SPAM in the US) requires a real mailing address in every commercial email.
          </span>
        </label>
        <label className="block">
          <span className="label">Sending email address</span>
          <input className="input" type="email" value={values.from_address} onChange={set("from_address")} maxLength={254} aria-invalid={invalid("from_address")} placeholder="hello@yourbusiness.com" />
          <span className="mt-1 block text-xs text-fg-dim">
            It counts once it is this workspace&apos;s Google Workspace mailbox and its test passed, or a team member&apos;s own connected Google account.
          </span>
        </label>
        <label className="block">
          <span className="label">Reply-to address (optional)</span>
          <input className="input" type="email" value={values.reply_to} onChange={set("reply_to")} maxLength={254} aria-invalid={invalid("reply_to")} placeholder="Leave empty to get replies at the sending address" />
        </label>
      </fieldset>

      <div className="rounded-lg border border-hairline bg-bg-deep/30 px-3 py-2.5">
        <div className="text-xs text-fg-dim">Every email from this workspace ends with</div>
        <div className="mt-1 whitespace-pre-line break-words text-[13px] leading-5 text-fg-muted">
          {[
            values.legal_name.trim() || "Legal business name",
            postalPreview || "Postal address",
            contact || "Sending email address",
            "To stop receiving these emails, unsubscribe here: (the reader's own link)",
          ].join("\n")}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" disabled={disabled || busy} className="btn-primary">
          {busy ? "Saving..." : "Save sending identity"}
        </button>
        {saved && <span className="text-sm text-status-engaged">{saved}</span>}
        {error && (
          <span role="alert" className="text-sm text-status-hot">
            {error.message}
          </span>
        )}
      </div>
    </form>
  );
}
