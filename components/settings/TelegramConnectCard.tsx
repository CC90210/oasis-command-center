"use client";

/**
 * TelegramConnectCard — self-service walkthrough that lets any employee create
 * their OWN Telegram bot in BotFather and link it, with no developer help.
 * Three states: (1) create + paste token, (2) message the bot to link the chat,
 * (3) connected. Backed by /api/integrations/personal/telegram.
 */

import { useEffect, useState } from "react";
import { Loader2, Check, Copy, Send, X } from "lucide-react";

type Status = { connected: boolean; username: string | null; linked: boolean; chat_id: string | null };

function CopyBtn({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => { try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1200); } catch {} }}
      className="inline-flex items-center gap-1 rounded border border-bg-border bg-bg-elev px-1.5 py-0.5 text-[11px] font-mono text-accent hover:border-accent/50"
    >
      {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />} {text}
    </button>
  );
}

export function TelegramConnectCard() {
  const [status, setStatus] = useState<Status | null>(null);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "unavailable">("loading");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState<null | "validate" | "link" | "disconnect">(null);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  async function refresh() {
    try {
      const r = await fetch("/api/integrations/personal/telegram", { cache: "no-store" });
      const b = (await r.json().catch(() => ({}))) as { ok?: boolean } & Status;
      if (r.ok && b.ok) {
        setStatus({ connected: b.connected, username: b.username, linked: b.linked, chat_id: b.chat_id });
        setLoadState("ready");
      } else {
        setStatus(null);
        setLoadState("unavailable");
      }
    } catch (refreshError) {
      console.error("[TelegramConnectCard.refresh]", refreshError);
      setStatus(null);
      setLoadState("unavailable");
    }
  }
  useEffect(() => { void refresh(); }, []);

  async function validate() {
    setBusy("validate"); setError(null); setFlash(null);
    try {
      const r = await fetch("/api/integrations/personal/telegram", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "validate", bot_token: token.trim() }),
      });
      const b = (await r.json().catch(() => ({}))) as { ok?: boolean; username?: string; error?: string };
      if (!b.ok) {
        setError(
          b.error === "invalid_token_format"
            ? "That doesn't look like a bot token (should be like 123456789:AA…)."
            : b.error === "telegram_rejected_token"
              ? "Telegram rejected that token. Copy it again from BotFather."
              : b.error === "telegram_store_failed"
                ? "Telegram verified the bot, but OASIS couldn't save it. No connection was recorded; try again."
                : "Couldn't reach Telegram. Try again.",
        );
        return;
      }
      setToken(""); setFlash(`Saved — bot @${b.username}. Now message it and send /start below.`);
      await refresh();
    } catch (validateError) {
      console.error("[TelegramConnectCard.validate]", validateError);
      setError("OASIS couldn't check or save this bot right now. No connection was recorded; try again.");
    } finally { setBusy(null); }
  }

  async function link() {
    setBusy("link"); setError(null); setFlash(null);
    try {
      const r = await fetch("/api/integrations/personal/telegram", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "link" }),
      });
      const b = (await r.json().catch(() => ({}))) as { ok?: boolean; chat_name?: string; error?: string };
      if (!b.ok) {
        setError(
          b.error === "no_message_yet"
            ? "I don't see a message yet. Open your bot in Telegram, tap Start (or send /start), then click Finish again."
            : b.error === "telegram_store_failed"
              ? "OASIS found your chat but couldn't save the link. It is not connected yet; try again."
              : "Couldn't link the chat. Try again.",
        );
        return;
      }
      setFlash(`Linked to ${b.chat_name}. You're connected ✓`);
      await refresh();
    } catch (linkError) {
      console.error("[TelegramConnectCard.link]", linkError);
      setError("OASIS couldn't finish the link right now. It is not connected yet; try again.");
    } finally { setBusy(null); }
  }

  async function disconnect() {
    if (!confirm("Disconnect your Telegram bot?")) return;
    setBusy("disconnect"); setError(null);
    try {
      const response = await fetch("/api/integrations/personal/telegram", { method: "DELETE" });
      const body = (await response.json().catch(() => ({}))) as { ok?: boolean };
      if (!response.ok || !body.ok) {
        setError("OASIS couldn't disconnect this bot. The existing connection is unchanged; try again.");
        return;
      }
      setFlash(null); setError(null);
      await refresh();
    } catch (disconnectError) {
      console.error("[TelegramConnectCard.disconnect]", disconnectError);
      setError("OASIS couldn't disconnect this bot. The existing connection is unchanged; try again.");
    } finally { setBusy(null); }
  }

  const connected = status?.connected === true;
  const linked = status?.linked === true;

  return (
    <div className="rounded-lg border border-bg-border bg-bg-deep/40 p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Send className="h-4 w-4 text-accent" />
            <span className="font-semibold text-sm text-fg">Your personal Telegram alert bot</span>
            {loadState === "loading" ? (
              <span className="inline-flex items-center gap-1 rounded border border-bg-border bg-bg-elev/60 px-1.5 py-0.5 text-[10px] font-medium text-fg-dim"><Loader2 className="h-3 w-3 animate-spin" /> Checking</span>
            ) : loadState === "unavailable" ? (
              <span className="inline-flex items-center gap-1 rounded border border-amber-500/30 bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-300">Status unavailable</span>
            ) : linked ? (
              <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-bold bg-emerald-500/15 text-emerald-300 border border-emerald-500/30"><Check className="h-3 w-3" />Connected</span>
            ) : connected ? (
              <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium bg-amber-500/15 text-amber-300 border border-amber-500/30">Bot saved · link your chat</span>
            ) : (
              <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium bg-bg-elev/60 text-fg-dim border border-bg-border">Not connected</span>
            )}
          </div>
          <div className="text-[11.5px] text-fg-muted mt-1 leading-relaxed">
            This bot belongs only to your signed-in profile. The shared Telegram bridge shown above can be healthy even when you have not linked a personal alert bot.
          </div>
        </div>
        {(connected || linked) && (
          <button type="button" onClick={disconnect} disabled={busy !== null} className="shrink-0 inline-flex items-center gap-1.5 rounded-md border border-bg-border bg-bg-elev px-3 py-1.5 text-[12px] font-bold text-fg-muted hover:text-red-300 hover:border-red-500/40 disabled:opacity-50">
            {busy === "disconnect" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <X className="h-3.5 w-3.5" />}Disconnect
          </button>
        )}
      </div>

      {flash && <div className="mt-3 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-[12px] text-emerald-200">{flash}</div>}
      {error && <div className="mt-3 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-[12px] text-red-200">{error}</div>}

      {loadState === "unavailable" && (
        <div className="mt-3 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[12px] text-amber-200">
          Personal Telegram status could not be checked. This is unknown—not disconnected. Refresh the page to try again.
        </div>
      )}

      {/* STEP 1 — create the bot + paste token (until a token is saved) */}
      {loadState === "ready" && !connected && (
        <div className="mt-3 space-y-2 text-[12.5px] text-fg-muted">
          <ol className="list-decimal ml-5 space-y-1.5">
            <li>In Telegram, open <CopyBtn text="@BotFather" /> and start a chat.</li>
            <li>Send <CopyBtn text="/newbot" /> and follow the prompts (pick any name + a username ending in <span className="font-mono text-fg-dim">bot</span>).</li>
            <li>BotFather replies with a <b>token</b> like <span className="font-mono text-fg-dim">123456789:AA…</span>. Copy it and paste it here:</li>
          </ol>
          <div className="flex items-center gap-2 pt-1">
            <input
              type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="Paste your bot token"
              className="flex-1 rounded-md border border-bg-border bg-bg-elev px-3 py-1.5 text-[12.5px] text-fg placeholder:text-fg-dim focus:border-accent/50 outline-none font-mono"
            />
            <button type="button" onClick={validate} disabled={busy !== null || !token.trim()} className="inline-flex items-center gap-1.5 rounded-md bg-accent text-bg-deep px-3 py-1.5 text-[12.5px] font-bold hover:bg-accent/90 disabled:opacity-60">
              {busy === "validate" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}Validate & save
            </button>
          </div>
        </div>
      )}

      {/* STEP 2 — link the chat (token saved, not yet linked) */}
      {loadState === "ready" && connected && !linked && (
        <div className="mt-3 space-y-2 text-[12.5px] text-fg-muted">
          <ol className="list-decimal ml-5 space-y-1.5">
            <li>Open your bot <span className="font-mono text-accent">@{status?.username}</span> in Telegram.</li>
            <li>Tap <b>Start</b> (or send <CopyBtn text="/start" />).</li>
            <li>Come back and click Finish linking:</li>
          </ol>
          <button type="button" onClick={link} disabled={busy !== null} className="inline-flex items-center gap-1.5 rounded-md bg-accent text-bg-deep px-3 py-1.5 text-[12.5px] font-bold hover:bg-accent/90 disabled:opacity-60">
            {busy === "link" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}Finish linking
          </button>
        </div>
      )}

      {/* STEP 3 — done */}
      {loadState === "ready" && linked && (
        <div className="mt-3 text-[12.5px] text-fg-muted">
          Bot <span className="font-mono text-accent">@{status?.username}</span> is linked to your Telegram. You&apos;ll get your alerts here.
        </div>
      )}
    </div>
  );
}
