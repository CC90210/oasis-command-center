/**
 * /desktop-link — turnkey landing for the OASIS Desktop app's sign-in
 * flow. The desktop opens this URL in the user's real browser. If the
 * user isn't signed in we bounce to /login?next=/desktop-link (with the
 * `intent` query forwarded so the login form respects forgot/signup
 * hints). Once signed in we mint a pair code server-side, then auto-fire
 * the oasis://pair?code=... deep-link via a meta-refresh + JS fallback.
 *
 * The 9-char code is also shown in plain text so corporate-policy
 * browsers that block custom URL schemes still have a paste path.
 */

import { redirect } from "next/navigation";
import { headers } from "next/headers";
import Link from "next/link";
import { OasisLogo } from "@/components/brand/OasisLogo";
import { getServiceSupabase, getSessionUser } from "@/lib/supabase-server";
import { DesktopLinkClient } from "./client";

export const dynamic = "force-dynamic";

type SearchParams = Promise<{ intent?: string; via?: string }>;

export default async function DesktopLinkPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const intent = (params?.intent || "").toString();
  const user = await getSessionUser();

  if (!user || !user.email) {
    const next = encodeURIComponent("/desktop-link" + (intent ? `?intent=${encodeURIComponent(intent)}` : ""));
    // Forgot-password and signup hints route to the right page directly.
    if (intent === "forgot") redirect(`/forgot-password?next=${next}`);
    if (intent === "signup") redirect(`/signup?next=${next}`);
    redirect(`/login?next=${next}`);
  }

  const db = getServiceSupabase();
  const profile = await db
    .from("user_profiles")
    .select("tenant_id, full_name")
    .eq("auth_user_id", user.id)
    .maybeSingle();

  if (profile.error || !profile.data?.tenant_id) {
    return (
      <Shell title="Almost there — finish provisioning first">
        <p className="text-fg-muted text-sm leading-relaxed">
          Your account doesn&apos;t have a tenant yet. Open the dashboard at <code className="text-accent">/settings</code> and complete provisioning, then come back to this page.
        </p>
        <Link href="/settings" className="mt-6 inline-block btn-secondary">Open Settings</Link>
      </Shell>
    );
  }

  // Mint a fresh 9-char code on every page load. The previous unconsumed
  // code (if any) is auto-revoked by the mint endpoint, so refreshing
  // this page is safe + idempotent. We mint inline rather than calling
  // the existing /api/auth/pair-code POST because (a) we already have a
  // service-role DB handle and (b) we want the same atomic dedupe that
  // the API does without the extra HTTP hop.
  const code = await mintCodeForUser(db, user.id, user.email, profile.data.tenant_id);
  if (!code.ok) {
    return (
      <Shell title="Could not generate a connect code">
        <p className="text-fg-muted text-sm leading-relaxed">
          The dashboard couldn&apos;t mint a one-time pair code right now: <code className="text-warn">{code.error}</code>. Try again in a moment — if it keeps failing, open Settings → Devices to generate one manually.
        </p>
      </Shell>
    );
  }

  // Compute the deep-link URL. The desktop app's protocol handler will
  // catch oasis://pair?code=... and exchange it for a bridge_token +
  // magic-link transparently.
  const deepLink = `oasis://pair?code=${encodeURIComponent(code.code)}`;
  const expiresMinutes = 15;

  // Pull the hostname so the trust copy says "agent-dashboard..." rather
  // than a generic phrase. Helps reassure users on first install.
  const h = await headers();
  const host = h.get("host") || "agent-dashboard-cc90210.vercel.app";

  return (
    <Shell title="Connecting your OASIS Desktop">
      <p className="text-fg-muted leading-relaxed mb-6">
        Signed in as <span className="text-fg font-medium">{user.email}</span>. We&apos;ll send a one-time connect code to your desktop app — keep this tab open while it lands.
      </p>
      <DesktopLinkClient code={code.code} deepLink={deepLink} expiresMinutes={expiresMinutes} host={host} />
      <div className="mt-8 border-t border-bg-border pt-6">
        <p className="text-xs uppercase tracking-[0.16em] text-fg-mute mb-2">Manual fallback</p>
        <p className="text-sm text-fg-muted leading-relaxed">
          If your browser blocked the auto-launch, copy this code and paste it into the desktop app&apos;s sign-in screen:
        </p>
        <div className="mt-3 flex items-center gap-3">
          <code className="text-lg font-mono tracking-[0.18em] font-bold text-accent bg-bg-elev border border-accent/30 rounded-lg px-4 py-3">
            {code.code}
          </code>
          <span className="text-xs text-fg-mute">expires in {expiresMinutes} min · single-use</span>
        </div>
      </div>
    </Shell>
  );
}

function Shell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <main className="min-h-screen bg-bg-deep text-fg flex flex-col">
      <header className="px-6 sm:px-10 py-6 border-b border-bg-border flex items-center justify-between">
        <Link href="/" className="flex items-center gap-2.5 group">
          <OasisLogo size={32} priority />
          <div className="leading-none">
            <div className="font-black tracking-tight text-fg text-sm">OASIS AI</div>
            <div className="text-[10px] uppercase tracking-[0.18em] text-fg-dim">Desktop Connect</div>
          </div>
        </Link>
        <Link href="/" className="text-xs text-fg-muted hover:text-fg">Skip to dashboard</Link>
      </header>
      <section className="flex-1 flex items-start justify-center px-6 sm:px-10 py-12">
        <div className="w-full max-w-xl bg-bg-elev/50 border border-bg-border rounded-2xl p-8 sm:p-10 backdrop-blur">
          <h1 className="text-2xl sm:text-3xl font-black tracking-tight text-fg mb-2">{title}</h1>
          {children}
        </div>
      </section>
    </main>
  );
}

async function mintCodeForUser(
  db: ReturnType<typeof getServiceSupabase>,
  authUserId: string,
  email: string,
  tenantId: string,
): Promise<{ ok: true; code: string } | { ok: false; error: string }> {
  // Mirrors /api/auth/pair-code/route.ts — alphabet excludes ambiguous
  // glyphs (0/O, 1/I/L) so the manual-paste fallback is human-readable.
  const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
  const { randomBytes } = await import("crypto");
  const mint = () => {
    const buf = randomBytes(9);
    const chars: string[] = [];
    for (let i = 0; i < 9; i++) chars.push(ALPHABET[buf[i] % ALPHABET.length]);
    return `${chars.slice(0, 3).join("")}-${chars.slice(3, 6).join("")}-${chars.slice(6, 9).join("")}`;
  };

  // Revoke any unconsumed prior codes so the per-user invariant holds.
  await db.from("bridge_pair_codes").delete().eq("auth_user_id", authUserId).is("consumed_at", null);

  const ttl = 15;
  for (let attempt = 0; attempt < 4; attempt++) {
    const code = mint();
    const expiresAt = new Date(Date.now() + ttl * 60_000).toISOString();
    const ins = await db.from("bridge_pair_codes").insert({
      code,
      tenant_id: tenantId,
      auth_user_id: authUserId,
      email,
      expires_at: expiresAt,
    });
    if (!ins.error) return { ok: true, code };
    if (attempt === 3) return { ok: false, error: ins.error.message };
  }
  return { ok: false, error: "mint_exhausted" };
}
