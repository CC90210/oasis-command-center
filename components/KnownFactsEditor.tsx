"use client";

import { useEffect, useState } from "react";

/**
 * KnownFactsEditor — operator-editable scratchpad of evergreen facts
 * that get auto-injected into every cloud chat as an "OPERATOR KNOWN
 * FACTS" block.
 *
 * Closes the 2026-05-24 cloud-parity gap: bridge-mode agents see
 * brain/USER.md and brain/STATE.md on disk; cloud-mode agents had no
 * equivalent operator-personal context, so they would ask "what's
 * your Google Calendar link?" every single time. Now the operator
 * pastes their link once here, every cloud chat knows it forever.
 *
 * Storage shape: user_profiles.custom_fields.quick_facts (Markdown
 * string). The shape lives in JSONB so we never need a migration for
 * "one more field" — calendar link today, signature tomorrow, brand
 * voice the day after.
 *
 * Server-side injection is in app/api/chat/route.ts (operatorBlock
 * → knownFactsBlock).
 */
export function KnownFactsEditor() {
  const [text, setText] = useState("");
  const [orig, setOrig] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch("/api/profile", { cache: "no-store" });
        const j = (await r.json().catch(() => ({}))) as {
          ok?: boolean;
          profile?: { custom_fields?: Record<string, unknown> | null };
          error?: string;
        };
        if (!r.ok || !j.ok) {
          setErr(j.error || "Failed to load profile");
          return;
        }
        const cf = (j.profile?.custom_fields || {}) as Record<string, unknown>;
        const initial = typeof cf.quick_facts === "string" ? cf.quick_facts : "";
        setText(initial);
        setOrig(initial);
      } catch (e) {
        setErr(e instanceof Error ? e.message : "Failed to load");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  async function onSave() {
    setSaving(true);
    setErr(null);
    setMsg(null);
    try {
      // Read-modify-write on custom_fields to preserve unrelated keys
      // (timezone, briefing_channel, photo url, etc.) that the welcome
      // wizard or other settings write to the same blob.
      const r = await fetch("/api/profile", { cache: "no-store" });
      const j = (await r.json().catch(() => ({}))) as {
        profile?: { custom_fields?: Record<string, unknown> | null };
      };
      const cf = { ...(j.profile?.custom_fields || {}) } as Record<string, unknown>;
      cf.quick_facts = text;

      const patch = await fetch("/api/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ custom_fields: cf }),
      });
      const patchBody = (await patch.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };
      if (!patch.ok || !patchBody.ok) {
        setErr(patchBody.error || `http_${patch.status}`);
        return;
      }
      setOrig(text);
      setMsg("Saved. New chats start using these facts immediately.");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  const dirty = text !== orig;

  if (loading) {
    return <div className="text-xs text-fg-dim">Loading…</div>;
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-fg-muted leading-relaxed max-w-3xl">
        Paste evergreen facts about yourself here — calendar booking link, email
        signature, business name, common phrasings, preferred meeting times.
        Every cloud chat with every agent will see this block as authoritative
        operator context. Saves you from typing the same things over and over.
      </p>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={12}
        placeholder={"- Calendar booking link: https://cal.com/your-handle\n- Email signature:\n    Best,\n    Your Name\n    Your Title · Your Brand\n- Business name: Your LLC\n- Preferred tone: warm + direct, no corporate fluff\n- Common asks: send invoices via Stripe links, never PDF attachments"}
        className="w-full bg-bg-elev border border-bg-border rounded-md px-3 py-2.5 text-sm font-mono text-fg focus:border-accent focus:outline-none resize-y"
      />
      {err && (
        <div className="text-sm text-status-hot bg-status-hot/10 border border-status-hot/30 rounded-md px-3 py-2">
          {err}
        </div>
      )}
      {msg && (
        <div className="text-sm text-status-engaged bg-status-engaged/10 border border-status-engaged/30 rounded-md px-3 py-2">
          {msg}
        </div>
      )}
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onSave}
          disabled={saving || !dirty}
          className="bg-accent text-bg font-bold py-2 px-4 rounded-md hover:bg-accent-muted transition-colors disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save known facts"}
        </button>
        {dirty && !saving && (
          <button
            type="button"
            onClick={() => setText(orig)}
            className="text-xs text-fg-dim hover:text-fg underline"
          >
            Discard changes
          </button>
        )}
      </div>
    </div>
  );
}
