import { NextResponse } from "next/server";
import { CC_REDIRECT_URI } from "./store";

/**
 * The OAuth flow runs in a popup so the operator's main SunBiz window never
 * navigates (and its Supabase session is never in the OAuth blast radius). This
 * renders the popup's result page: it postMessages the opener + closes itself. If
 * there's no opener (popup was blocked → full-window fallback), it redirects back
 * to /email-blast with the status so the page can still show the outcome.
 */
export function ccPopupResult(status: "connected" | "denied" | "error", reason?: string): NextResponse {
  const origin = new URL(CC_REDIRECT_URI).origin;
  const returnUrl = `${origin}/email-blast?constant_contact=${status}${reason ? `&reason=${encodeURIComponent(reason)}` : ""}`;
  const msg = JSON.stringify({ source: "cc_oauth", status, reason: reason || null });
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Constant Contact</title></head>
<body style="font:14px system-ui,-apple-system,sans-serif;padding:28px;color:#333">
Finishing up. You can close this window.
<script>(function(){try{if(window.opener&&!window.opener.closed){window.opener.postMessage(${msg},${JSON.stringify(origin)});window.close();return;}}catch(e){}location.replace(${JSON.stringify(returnUrl)});})();</script>
</body></html>`;
  return new NextResponse(html, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}
