/**
 * lib/connections/popup.ts — the page an OAuth popup lands on when a connect
 * finishes: it postMessages the opener (the Settings › Connections hub) and
 * closes. Generalized from lib/integrations/constant-contact/popup.ts.
 *
 * `reason` can come from the provider's `?error=` query string, so it is
 * attacker-controlled. It is embedded only through jsonForScript (script-safe:
 * `<`, `>`, `&`, U+2028 and U+2029 escaped) and encodeURIComponent, and a
 * nonce'd Content-Security-Policy refuses any inline script that is not ours.
 * The message is posted to the app's own origin only.
 */
import "server-only";
import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";

/** The `source` the hub listens for (components/os/connections/ConnectionsHub.tsx). */
export const CONNECTION_POPUP_SOURCE = "oasis_connection";

export type ConnectionPopupStatus = "connected" | "denied" | "error";

/** JSON for an inline <script>: a value cannot close the element or start markup. */
export function jsonForScript(value: unknown): string {
  const LS = String.fromCharCode(0x2028);
  const PS = String.fromCharCode(0x2029);
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .split(LS)
    .join("\\u2028")
    .split(PS)
    .join("\\u2029");
}

/** The app origin from PUBLIC_APP_URL. No origin, no postMessage target: refuse. */
export function appOrigin(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const raw = (env.PUBLIC_APP_URL || "").trim();
  if (!raw) throw new Error("PUBLIC_APP_URL is not set; the connection popup has no origin to report to");
  return new URL(raw).origin;
}

export function connectionPopupResult(input: {
  provider: string;
  status: ConnectionPopupStatus;
  reason?: string | null;
  origin: string;
}): NextResponse {
  const reason = input.reason ? String(input.reason).slice(0, 200) : null;
  const returnUrl =
    `${input.origin}/settings/connections?connection=${encodeURIComponent(input.provider)}` +
    `&status=${input.status}${reason ? `&reason=${encodeURIComponent(reason)}` : ""}`;
  const msg = jsonForScript({ source: CONNECTION_POPUP_SOURCE, provider: input.provider, status: input.status, reason });
  const nonce = randomBytes(16).toString("base64");
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Connecting</title></head>
<body style="font:14px system-ui,-apple-system,sans-serif;padding:28px;color:#333">
Finishing up. You can close this window.
<script nonce="${nonce}">(function(){try{if(window.opener&&!window.opener.closed){window.opener.postMessage(${msg},${jsonForScript(input.origin)});window.close();return;}}catch(e){}location.replace(${jsonForScript(returnUrl)});})();</script>
</body></html>`;
  return new NextResponse(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'`,
    },
  });
}
