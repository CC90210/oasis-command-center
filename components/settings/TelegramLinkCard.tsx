"use client";

/**
 * TelegramLinkCard — self-serve Telegram linking (Batch 4). The signed-in user
 * generates a one-time code, opens the SunBiz bot, and sends `/start <code>`
 * (or taps the deep link); the webhook links their chat so they receive per-lead
 * application alerts. No chat IDs to collect manually.
 */
import { useState } from "react";
import { Send, Loader2, Copy, Check } from "lucide-react";

export function TelegramLinkCard() {
  const [code, setCode] = useState<string | null>(null);
  const [deepLink, setDeepLink] = useState<string | null>(null);
  const [instructions, setInstructions] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function generate() {
    setBusy(true);
    setErr(null);
    setCopied(false);
    try {
      const r = await fetch("/api/telegram/link-code", { method: "POST", credentials: "include" });
      const j = await r.json().catch(() => ({}));
      if (r.ok && j.ok) {
        setCode(j.code);
        setDeepLink(j.deep_link || null);
        setInstructions(j.instructions || null);
      } else {
        setErr(j.error || "Couldn't generate a code. Try again.");
      }
    } catch (e) {
      setErr(String((e as Error).message || e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-xl border border-bg-border bg-bg-elev/40 p-4 space-y-3">
      <div className="flex items-center gap-2">
        <Send className="h-4 w-4 text-accent" />
        <h3 className="text-sm font-bold text-fg">Telegram alerts</h3>
      </div>
      <p className="text-[12px] text-fg-muted leading-relaxed">
        Get a ping on your phone when one of your leads submits an application or uploads bank
        statements. Generate a code, then send it to the SunBiz bot to link your chat.
      </p>

      {!code ? (
        <button
          type="button"
          onClick={generate}
          disabled={busy}
          className="inline-flex items-center gap-2 text-[12.5px] font-semibold px-3 py-2 rounded-md bg-accent text-bg-deep disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
          Link Telegram
        </button>
      ) : (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <code className="px-2.5 py-1 rounded-md bg-bg-deep border border-bg-border text-fg font-mono text-sm tracking-widest">
              {code}
            </code>
            <button
              type="button"
              onClick={() => {
                navigator.clipboard?.writeText(`/start ${code}`).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                });
              }}
              className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-md border border-bg-border text-fg-muted hover:text-fg"
            >
              {copied ? <Check className="h-3 w-3 text-emerald-300" /> : <Copy className="h-3 w-3" />}
              {copied ? "Copied" : "Copy /start"}
            </button>
          </div>
          {deepLink && (
            <a
              href={deepLink}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-block text-[12px] text-accent hover:underline"
            >
              Open the SunBiz bot →
            </a>
          )}
          <p className="text-[11px] text-fg-dim">
            {instructions || `Open the SunBiz Telegram bot and send: /start ${code}`} The code expires in
            10 minutes.
          </p>
        </div>
      )}
      {err && <p className="text-[11px] text-red-300">{err}</p>}
    </div>
  );
}
