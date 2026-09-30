/**
 * The full-React half of tests/system-health-loader.test.ts.
 *
 * WHY A SEPARATE PROCESS. The suite runs with `--conditions=react-server`,
 * where react-dom/server does not resolve and React has no useState, so the
 * client IntegrationDot cards /health hands its heartbeats to cannot be drawn
 * there. The test writes the props the page gave each card to a JSON file and
 * spawns this with plain `node --import tsx <file>`; this prints the markup.
 *
 * It also draws four fixed cases the rules hinge on (2026-09-30): a healthy
 * ping older than a day (Stale), a key with no ping (Key on file, never
 * Connected), a healthy ping inside the day (Connected), and a key read that
 * failed (Couldn't check).
 *
 * It asserts nothing: every assertion lives in the .test.ts.
 */
import { readFileSync } from "node:fs";
import { dirname } from "node:path";

function stub(request: string, exports: Record<string, unknown>) {
  const p = require.resolve(request);
  require.cache[p] = { id: p, filename: p, path: dirname(p), loaded: true, children: [], paths: [], exports } as unknown as NodeModule;
}

async function main() {
  const React = await import("react");
  (globalThis as unknown as { React: typeof React }).React = React;
  stub("next/navigation", {
    useRouter: () => ({ push: () => undefined, refresh: () => undefined, prefetch: () => undefined, replace: () => undefined }),
    usePathname: () => "/health",
    useSearchParams: () => new URLSearchParams(),
  });
  stub("next/link", {
    __esModule: true,
    default: ({ href, children, prefetch: _prefetch, ...rest }: { href: string; prefetch?: boolean; children?: unknown }) =>
      React.createElement("a", { href, ...rest }, children as React.ReactNode),
  });
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { IntegrationDot } = await import("../components/IntegrationDot");

  const recorded = JSON.parse(readFileSync(process.argv[2], "utf8")) as Array<Record<string, unknown>>;
  const draw = (props: Record<string, unknown>) =>
    renderToStaticMarkup(React.createElement(IntegrationDot, props as Parameters<typeof IntegrationDot>[0]));

  const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
  const row = (service: string, status: string, lastPingAt: string | null) => ({
    id: `r-${service}`,
    profile_id: null,
    tenant_id: "tenant-a",
    service,
    status,
    last_ping_at: lastPingAt,
    last_error: null,
    metadata: {},
    updated_at: new Date().toISOString(),
  });

  const out = {
    page: recorded.map(draw),
    staleHealthy: draw({ health: row("openrouter", "healthy", hoursAgo(30)), connection: { hasCredentials: true } }),
    keyOnly: draw({ health: row("anthropic", "unconfigured", null), connection: { hasCredentials: true } }),
    // A "healthy" status with no ping at all is a stored word, not a check-in.
    healthyNoPing: draw({ health: row("anthropic", "healthy", null), connection: { hasCredentials: true } }),
    freshHealthy: draw({ health: row("openrouter", "healthy", hoursAgo(1)), connection: { hasCredentials: true } }),
    unknownKey: draw({ health: row("google_ai", "unconfigured", null), connection: { hasCredentials: null } }),
  };
  process.stdout.write(JSON.stringify(out));
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
