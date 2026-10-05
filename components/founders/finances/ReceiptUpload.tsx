"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

/** Attach a receipt (PDF/image) to a bill or a transaction. */
export function ReceiptUpload({ ownerType, ownerId }: { ownerType: "bill" | "transaction"; ownerId: string }) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <span className="inline-flex items-center gap-2">
      <input
        ref={input}
        type="file"
        accept="application/pdf,image/jpeg,image/png,image/webp,image/heic"
        className="hidden"
        onChange={async (e) => {
          const f = e.target.files?.[0];
          if (!f) return;
          setBusy(true);
          setErr(null);
          const fd = new FormData();
          fd.set("file", f);
          fd.set("owner_type", ownerType);
          fd.set("owner_id", ownerId);
          const res = await fetch("/api/founders/finances/attachments", { method: "POST", body: fd }).catch(() => null);
          const json = res ? ((await res.json().catch(() => null)) as Record<string, unknown> | null) : null;
          setBusy(false);
          if (!res || !res.ok || !json?.ok) setErr((json?.message as string) || "Upload failed");
          else router.refresh();
          if (input.current) input.current.value = "";
        }}
      />
      <button type="button" disabled={busy} onClick={() => input.current?.click()} className="text-xs text-fg-muted underline-offset-2 hover:text-fg hover:underline">
        {busy ? "Uploading…" : "Attach receipt"}
      </button>
      {err && <span className="text-xs text-status-hot">{err}</span>}
    </span>
  );
}
