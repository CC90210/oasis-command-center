import { NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { CC_REDIRECT_URI } from "./store";

/**
 * JSON-stringify a value for SAFE embedding inside an inline <script>. Plain
 * JSON.stringify escapes quotes/backslashes but NOT `<`, so a value containing
 * `</script>` (or an HTML comment) would break out of the script element and
 * execute as markup — a reflected-XSS vector because `reason` is attacker-
 * controlled (arrives via the callback's `?error=` query param). Escaping `<`,
 * `>`, `&` and the JS line separators U+2028/2029 to their \uXXXX forms closes
 * the breakout while keeping the value a valid JS string literal.
 */
function jsonForScript(value: unknown): string {
  // U+2028 / U+2029 are JS line terminators, so they can't appear as literal
  // chars in source (and a `\u` escape inside a regex literal is brittle here) —
  // build them via fromCharCode and swap with split/join.
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

/**
 * The OAuth flow runs in a popup so the operator's main SunBiz window never
 * navigates (and its Supabase session is never in the OAuth blast radius). This
 * renders the popup's result page: it postMessages the opener + closes itself. If
 * there's no opener (popup was blocked → full-window fallback), it redirects back
 * to /email-blast with the status so the page can still show the outcome.
 *
 * Untrusted `reason` is embedded ONLY via jsonForScript (script-safe) and via
 * encodeURIComponent (URL-safe), and a nonce'd Content-Security-Policy blocks
 * any inline script that isn't ours — defense-in-depth against markup injection.
 */
export function ccPopupResult(status: "connected" | "denied" | "error", reason?: string): NextResponse {
  const origin = new URL(CC_REDIRECT_URI).origin;
  const returnUrl = `${origin}/email-blast?constant_contact=${status}${reason ? `&reason=${encodeURIComponent(reason)}` : ""}`;
  const msg = jsonForScript({ source: "cc_oauth", status, reason: reason || null });
  const nonce = randomBytes(16).toString("base64");
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Constant Contact</title></head>
<body style="font:14px system-ui,-apple-system,sans-serif;padding:28px;color:#333">
Finishing up. You can close this window.
<script nonce="${nonce}">(function(){try{if(window.opener&&!window.opener.closed){window.opener.postMessage(${msg},${jsonForScript(origin)});window.close();return;}}catch(e){}location.replace(${jsonForScript(returnUrl)});})();</script>
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
