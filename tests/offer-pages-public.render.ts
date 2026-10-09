/**
 * The full-React half of tests/offer-pages-public.test.ts.
 *
 * WHY A SEPARATE PROCESS. The suite runs with `--conditions=react-server`,
 * where react-dom/server does not resolve, so the public page's client parts
 * (FormPublicClient, the video facade, the results viewer) and the Offers list
 * (FormsListClient) cannot be drawn there. The test spawns this with plain `node --import tsx` (the condition
 * removed from NODE_OPTIONS for the child, the way tests/workspace-alerts.test.ts
 * does), feeds it scenarios on stdin and reads the markup back as JSON.
 *
 * TODAY'S MARKUP. `--write-fixture` renders FormPublicClient with
 * tests/fixtures/offer-pages/form-only.props.json and writes
 * tests/fixtures/offer-pages/form-only.html. That file was written from the
 * component as it was BEFORE offer pages existed (main at 34a2944f), and the
 * test compares today's render with it byte for byte: a form with no published
 * offer page must render exactly as it always has. If FormPublicClient's markup
 * is changed ON PURPOSE later, regenerate it with:
 *   node --import tsx tests/offer-pages-public.render.ts --write-fixture
 *
 * `React` is set on globalThis before any component loads: tsconfig.json sets
 * jsx:"preserve", so tsx compiles components with the classic runtime.
 * next/navigation, next/link and next/font/local are stood in (no app router or
 * Next compiler here), and the marketing stylesheet resolves to nothing.
 *
 * It asserts nothing: every assertion lives in the .test.ts.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const ROOT = join(__dirname, "..");
const FIXTURE_PROPS = join(ROOT, "tests", "fixtures", "offer-pages", "form-only.props.json");
const FIXTURE_HTML = join(ROOT, "tests", "fixtures", "offer-pages", "form-only.html");

function stubPath(p: string, exports: Record<string, unknown>) {
  require.cache[p] = { id: p, filename: p, path: dirname(p), loaded: true, children: [], paths: [], exports } as unknown as NodeModule;
}

async function main() {
  const React = await import("react");
  (globalThis as unknown as { React: typeof React }).React = React;
  stubPath(require.resolve("next/navigation"), {
    useRouter: () => ({ push: () => undefined, refresh: () => undefined, prefetch: () => undefined, replace: () => undefined }),
    usePathname: () => "/f/oasis-ai-cc/ai-audit",
    useSearchParams: () => new URLSearchParams(),
  });
  stubPath(require.resolve("next/link"), {
    __esModule: true,
    default: ({ href, children, prefetch: _prefetch, ...rest }: { href: string; prefetch?: boolean; children?: unknown }) =>
      React.createElement("a", { href, ...rest }, children as React.ReactNode),
  });
  // next/font/local is compiled away by Next; at plain runtime it throws. A
  // font here is its class names only.
  stubPath(require.resolve("next/font/local"), {
    __esModule: true,
    default: (opts: { variable?: string }) => ({
      className: "font-stub",
      variable: `font-var-${String(opts.variable || "x").replace(/[^a-z]/gi, "")}`,
      style: { fontFamily: "stub" },
    }),
  });
  stubPath(join(ROOT, "app", "(marketing)", "marketing.css"), {});

  const { renderToStaticMarkup } = await import("react-dom/server");
  const { FormPublicClient } = await import("../components/forms/FormPublicClient");
  const formOnlyProps = JSON.parse(readFileSync(FIXTURE_PROPS, "utf8")) as Parameters<typeof FormPublicClient>[0];

  if (process.argv.includes("--write-fixture")) {
    writeFileSync(FIXTURE_HTML, renderToStaticMarkup(React.createElement(FormPublicClient, formOnlyProps)) + "\n");
    process.stdout.write(`wrote ${FIXTURE_HTML}\n`);
    return;
  }

  // Scenarios from the test, on stdin: { name: { kind: "form" | "offer" | "list", props } }.
  // The props are exactly what the real page handed each component ("list" is
  // the Offers list, FormsListClient). Like Next's server render, there is no
  // window here; a render that throws is reported per scenario, so the test
  // names the one that broke.
  const { OfferPage } = await import("../components/offer-pages/OfferPage");
  const { FormsListClient } = await import("../components/forms/FormsListClient");
  const input = await new Promise<string>((resolve) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (buf += c));
    process.stdin.on("end", () => resolve(buf));
  });
  const scenarios = (input.trim() ? JSON.parse(input) : {}) as Record<string, { kind: "form" | "offer" | "list"; props: Record<string, unknown> }>;
  const out: Record<string, unknown> = {
    fixtureForm: renderToStaticMarkup(React.createElement(FormPublicClient, formOnlyProps)),
  };
  for (const [name, s] of Object.entries(scenarios)) {
    try {
      out[name] =
        s.kind === "form"
          ? renderToStaticMarkup(React.createElement(FormPublicClient, s.props as Parameters<typeof FormPublicClient>[0]))
          : s.kind === "list"
            ? renderToStaticMarkup(React.createElement(FormsListClient, s.props as Parameters<typeof FormsListClient>[0]))
            : renderToStaticMarkup(React.createElement(OfferPage, s.props as Parameters<typeof OfferPage>[0]));
    } catch (e) {
      out[name] = `RENDER FAILED: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
  process.stdout.write(JSON.stringify(out));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
