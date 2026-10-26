/**
 * The line a Content page shows when a Download pressed on it failed.
 *
 * The download route (app/api/founders/marketing/assets/[id]/download) sends
 * the browser back to the page it came from with ?download=<code>; this says
 * what that code means in a sentence (lib/founders/asset-download.ts
 * downloadFailureLine), announced as an alert. Any other value draws nothing.
 * A server component: no state, no script.
 */
import { downloadFailureLine } from "@/lib/founders/asset-download";

export function DownloadFailureNotice({ code }: { code?: string | string[] | null }) {
  const line = downloadFailureLine(Array.isArray(code) ? code[0] : code);
  if (!line) return null;
  return (
    <p role="alert" className="rounded-lg border border-status-hot/40 bg-status-hot/10 px-3 py-2 text-xs text-status-hot" data-testid="download-failed">
      {line}
    </p>
  );
}
