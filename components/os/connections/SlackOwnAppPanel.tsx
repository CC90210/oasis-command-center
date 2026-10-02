"use client";

/**
 * SlackOwnAppPanel - inside the Slack drawer, for a client workspace: exactly
 * what to create in its own Slack, and the form that saves the app's
 * credentials (CC, 2026-10-01: "the client is responsible for obtaining the API
 * key").
 *
 * Everything shown comes from the server (GET /api/integrations/slack/app,
 * built by lib/slack/own-app-setup.ts): the manifest, the redirect URL, the two
 * Request URLs carrying this workspace's id, the bot scopes and events. Nothing
 * here is hand-written. The values go to the encrypted key store through the
 * same ServiceKeysForm every keyed app uses ("slack_app"). Slack checks them
 * itself (the client ID and secret at Add to Slack, the signing secret when it
 * verifies the Request URL), so there is no Test button promising a check
 * OASIS cannot make.
 */

import { useCallback, useEffect, useState } from "react";
import { ServiceKeysForm } from "@/components/os/connections/ServiceKeysForm";
import { CopyRow } from "@/components/os/connections/TwilioWebhooksPanel";

type Info = {
  redirect_url: string;
  events_url: string;
  interactivity_url: string;
  bot_scopes: string[];
  bot_events: string[];
  manifest: Record<string, unknown>;
  app: "saved" | "incomplete" | "none" | "unreadable";
  installs_possible: boolean;
};

export const SLACK_OWN_APP_ENDPOINT = "/api/integrations/slack/app";

export function SlackOwnAppPanel({ onChanged, embedded }: { onChanged: () => void; embedded: boolean }) {
  const [info, setInfo] = useState<Info | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(SLACK_OWN_APP_ENDPOINT, { credentials: "include", cache: "no-store" });
      const data = (await res.json().catch(() => null)) as (Info & { ok?: boolean; error?: string }) | null;
      if (res.ok && data?.ok) {
        setInfo(data);
        setLoadError(null);
      } else {
        setLoadError(data?.error || `HTTP ${res.status}`);
      }
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "network_error");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // A save or a removal changes what the card says; re-read both.
  const changed = useCallback(() => {
    onChanged();
    void load();
  }, [onChanged, load]);

  const manifest = info ? JSON.stringify(info.manifest, null, 2) : "";
  const copyManifest = async () => {
    try {
      await navigator.clipboard.writeText(manifest);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  return (
    <section className="space-y-4">
      <div>
        <h3 className="mb-1.5 text-xs font-medium text-fg-dim">Set up your Slack app</h3>
        <ol className="list-decimal space-y-1.5 pl-5 text-[13px] leading-5 text-fg-muted marker:text-fg-dim">
          <li>
            In Slack, open{" "}
            <a href="https://api.slack.com/apps" target="_blank" rel="noopener noreferrer" className="text-accent underline-offset-2 hover:underline">
              api.slack.com/apps
            </a>
            , choose Create New App, then From a manifest. Pick your Slack workspace and paste the manifest below.
          </li>
          <li>In the new app, open Basic Information and copy its Client ID, Client Secret and Signing Secret into the form below, then Save.</li>
          <li>In the app&apos;s Event Subscriptions, have Slack check the Request URL again: it shows Verified once OASIS has the signing secret.</li>
          <li>
            {embedded
              ? "Once your workspace setup is finished, press Add to Slack under Settings > Chat apps and approve it."
              : "Press Add to Slack under Chat apps and approve it. Do not use Install to Workspace inside Slack: OASIS has to receive the install."}
          </li>
        </ol>
      </div>

      {loadError ? (
        <p className="rounded-lg border border-status-warm/30 bg-status-warm/10 px-3 py-2 text-[13px] leading-5 text-fg">
          The setup details could not be read ({loadError}). Refresh to try again.
        </p>
      ) : !info ? (
        <p className="text-[13px] text-fg-dim">Loading...</p>
      ) : (
        <>
          <div className="space-y-1">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[12px] font-medium text-fg-dim">Manifest</span>
              <button type="button" onClick={copyManifest} className="btn-secondary shrink-0">
                {copied ? "Copied" : "Copy manifest"}
              </button>
            </div>
            <pre className="max-h-48 overflow-auto rounded-md border border-hairline bg-bg-raised px-2 py-1.5 font-mono text-[11.5px] leading-4 text-fg">
              {manifest}
            </pre>
          </div>
          <details className="space-y-3 rounded-lg border border-hairline px-3 py-2">
            <summary className="cursor-pointer text-[13px] text-fg-muted">Setting the app up by hand instead</summary>
            <div className="mt-3 space-y-3">
              <CopyRow label="Redirect URL" value={info.redirect_url} hint="OAuth & Permissions, Redirect URLs." />
              <CopyRow
                label="Event Subscriptions Request URL"
                value={info.events_url}
                hint={`Event Subscriptions, Request URL. Subscribe to these bot events: ${info.bot_events.join(", ")}.`}
              />
              <CopyRow label="Interactivity Request URL" value={info.interactivity_url} hint="Interactivity & Shortcuts, Request URL." />
              <p className="text-[12px] leading-4 text-fg-dim">
                Bot token scopes (OAuth & Permissions): <span className="font-mono text-fg">{info.bot_scopes.join(", ")}</span>
              </p>
            </div>
          </details>
          {info.app === "saved" && !info.installs_possible && (
            <p className="rounded-lg border border-status-warm/30 bg-status-warm/10 px-3 py-2 text-[13px] leading-5 text-fg">
              Your Slack app is saved, but Slack installs are not switched on here yet, so it cannot be installed. Nothing is
              wrong on your side.
            </p>
          )}
          {info.app === "unreadable" && (
            <p className="rounded-lg border border-status-warm/30 bg-status-warm/10 px-3 py-2 text-[13px] leading-5 text-fg">
              Your Slack app&apos;s saved details could not be read. Paste them again and Save.
            </p>
          )}
        </>
      )}

      <ServiceKeysForm service="slack_app" appName="Slack app" canManage onChanged={changed} canTest={false} />
    </section>
  );
}
