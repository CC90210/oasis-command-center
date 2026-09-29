/**
 * Notice — the one-line result under a Connections action ("Saved.", "The
 * check with Stripe passed.", "Twilio could not be connected…"). One style for
 * the hub banner and every drawer form, so a success and a failure always read
 * the same way.
 */

export type NoticeValue = { tone: "ok" | "err"; text: string } | null;

export function Notice({ notice }: { notice: NoticeValue }) {
  if (!notice) return null;
  return (
    <p
      role="status"
      className={`rounded-lg border px-3 py-2 text-[13px] leading-5 text-fg ${
        notice.tone === "ok" ? "border-status-engaged/30 bg-status-engaged/10" : "border-status-hot/30 bg-status-hot/10"
      }`}
    >
      {notice.text}
    </p>
  );
}
