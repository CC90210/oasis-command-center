"use client";

/**
 * Download and Delete for one extracted video (app/founders/marketing/extracted,
 * and an extracted video's own asset page).
 *
 * Download is the attachment route every Library video uses
 * (app/api/founders/marketing/assets/[id]/download): a signed URL with a
 * download filename, so the browser saves the file instead of playing it.
 *
 * Delete is the Library's own DELETE route (assets/[id]), tenant-scoped and
 * read back. That route removes the rows and keeps the stored file (it is
 * returned as an orphan for a later sweep), and the confirm line says so. It
 * asks first, on the card itself: the viewer shows no browser confirmation
 * dialog, and a delete with no second step is one stray tap from losing a video.
 * After it lands the list refreshes from the server (or, from the asset page,
 * goes back to the list), so the card is gone because the row is gone.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";

const TAP = "min-h-11 min-w-11";

export function ExtractedVideoActions({
  assetId,
  title,
  afterDeleteHref,
}: {
  assetId: string;
  title: string;
  /** Where to go once deleted; absent = refresh this page (the list). */
  afterDeleteHref?: string;
}) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [deleted, setDeleted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/founders/marketing/assets/${assetId}`, { method: "DELETE" });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean };
      if (!res.ok || !body.ok) {
        setError("Couldn't delete it. Try again.");
        return;
      }
      // The row is gone: say so here even if the refresh below is slow or fails,
      // so the card never sits on "Deleting..." with every button disabled.
      setDeleted(true);
      setConfirming(false);
      if (afterDeleteHref) router.push(afterDeleteHref);
      else router.refresh();
    } catch {
      setError("Couldn't delete it. Try again.");
    } finally {
      setBusy(false);
    }
  }

  if (deleted) {
    return (
      <p className="text-xs text-fg-muted" role="status">
        Deleted.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <a
          href={`/api/founders/marketing/assets/${assetId}/download`}
          className={`btn-primary inline-flex items-center ${TAP}`}
          data-testid={`extracted-download-${assetId}`}
        >
          Download
        </a>
        {!confirming && (
          <button
            type="button"
            className={`btn-secondary inline-flex items-center ${TAP}`}
            onClick={() => setConfirming(true)}
            data-testid={`extracted-delete-${assetId}`}
          >
            Delete
          </button>
        )}
      </div>
      {confirming && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-hairline px-3 py-2" role="group" aria-label={`Delete ${title}`}>
          <span className="text-xs text-fg-muted">
            Delete this video? It leaves this page; the stored file is kept so it can be recovered.
          </span>
          <button
            type="button"
            className={`btn-primary inline-flex items-center ${TAP}`}
            disabled={busy}
            onClick={remove}
            data-testid={`extracted-delete-confirm-${assetId}`}
          >
            {busy ? "Deleting..." : "Delete"}
          </button>
          <button
            type="button"
            className={`btn-secondary inline-flex items-center ${TAP}`}
            disabled={busy}
            onClick={() => {
              setConfirming(false);
              setError(null);
            }}
          >
            Cancel
          </button>
        </div>
      )}
      {error && (
        <p className="text-xs text-status-hot" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
