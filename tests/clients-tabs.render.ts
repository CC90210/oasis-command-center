/**
 * The browser-component half of tests/clients-tabs.test.ts.
 *
 * WHY A SEPARATE PROCESS. The suite runs with `--conditions=react-server`,
 * under which `react-dom/server` does not resolve and `react` exports no
 * hooks. OsTabBar, the Clients list's status view and the record header's
 * "Write to client" are client components, so the only way to see what they
 * draw is to render them where React is whole. The test spawns THIS file with
 * plain `node --import tsx` and asserts against the markup and the recorded
 * events printed here.
 *
 * next/link and next/navigation are stand-ins (the App Router is not mounted
 * here): the address bar is `searchParams`, and the Link records the props
 * each tab was given, so the test can fire a tab's onNavigate / onMouseEnter
 * exactly as Next would on a click or a hover, and see what the component does
 * with it: cancel the navigation and write the address bar (a status tab), or
 * let it go and warm the route (a record tab).
 *
 * It asserts nothing: every assertion lives in the .test.ts.
 */

// A module, not a global script: its `main` must not collide with other
// scripts' under `tsc --noEmit -p .`.
export {};

type LinkProps = {
  href: string;
  prefetch?: unknown;
  className?: string;
  "aria-current"?: string;
  onNavigate?: (e: { preventDefault: () => void }) => void;
  onMouseEnter?: () => void;
  onFocus?: () => void;
  children?: unknown;
};

let searchParams = new URLSearchParams();
let pending = false;
let links: LinkProps[] = [];
const routerCalls: string[] = [];
const historyCalls: string[] = [];

function stub(id: string, exports: Record<string, unknown>) {
  const p = require.resolve(id);
  require.cache[p] = { id: p, filename: p, loaded: true, children: [], paths: [], exports } as unknown as NodeModule;
}

/** Fire what Next fires for a plain click on the tab to `href`: onNavigate. Returns whether the navigation was cancelled. */
function click(href: string): { cancelled: boolean; href: string } {
  const tab = links.find((l) => l.href === href);
  if (!tab) throw new Error(`no tab to ${href}`);
  let cancelled = false;
  tab.onNavigate?.({ preventDefault: () => void (cancelled = true) });
  return { cancelled, href: tab.href };
}

async function main() {
  const React = await import("react");
  (globalThis as unknown as { React: typeof React }).React = React;
  stub("next/navigation", {
    useRouter: () => ({
      prefetch: (h: string) => void routerCalls.push(`prefetch ${h}`),
      push: (h: string) => void routerCalls.push(`push ${h}`),
      replace: (h: string) => void routerCalls.push(`replace ${h}`),
      refresh: () => void routerCalls.push("refresh"),
    }),
    useSearchParams: () => searchParams,
    usePathname: () => "/clients",
  });
  const LinkStub = (props: LinkProps) => {
    links.push(props);
    return React.createElement(
      "a",
      { href: props.href, className: props.className, "aria-current": props["aria-current"] },
      props.children as React.ReactNode,
    );
  };
  stub("next/link", { __esModule: true, default: LinkStub, useLinkStatus: () => ({ pending }) });

  const { renderToStaticMarkup } = await import("react-dom/server");
  const { OsTabBar } = await import("../components/os/OsTabBar");
  const { ClientsByStatus, ClientStatusField, ClearClientFilters, ClientRecordTabs } = await import("../components/os/landings/clients-status");
  const { WriteToClientLink } = await import("../components/os/landings/client-conversations");
  const h = React.createElement;
  const render = (el: React.ReactElement, url = "") => {
    searchParams = new URLSearchParams(url);
    links = [];
    return renderToStaticMarkup(el);
  };
  const out: Record<string, unknown> = {};

  // -- A client record's tabs: drawn by the record's layout, they navigate --
  const recordTabs = ["overview", "conversations", "tickets", "money"].map((k) => ({
    key: k,
    label: k[0].toUpperCase() + k.slice(1),
    href: k === "overview" ? "/clients/c1" : `/clients/c1?tab=${k}`,
  }));
  const recordBar = () => h(OsTabBar, { label: "Client record", tabs: recordTabs, param: "tab" });
  out.record = render(recordBar(), "tab=money");
  out.recordPrefetch = links.map((l) => l.prefetch);
  links.find((l) => l.href === "/clients/c1?tab=tickets")?.onMouseEnter?.();
  links.find((l) => l.href === "/clients/c1?tab=conversations")?.onFocus?.();
  out.recordWarm = [...routerCalls];
  out.recordClick = click("/clients/c1?tab=tickets");
  out.recordNoTab = render(recordBar(), "");
  out.recordUnknownTab = render(recordBar(), "tab=usage");
  // The record layout's own bar (clients-status.tsx ClientRecordTabs).
  out.recordLayoutBar = render(h(ClientRecordTabs, { tabs: recordTabs }), "tab=tickets");
  pending = true;
  out.recordPending = render(recordBar(), "tab=money");
  pending = false;

  // -- The Clients list: status tabs filter what the page holds -------------
  const lifecycles = ["active", "churned", "prospect", "active"];
  const row = (name: string) => h("tr", { key: name }, h("td", null, name));
  const rows = [row("Alpha Active"), row("Bravo Past"), row("Charlie Prospect"), row("Delta Active")];
  const tabs = ["", "prospect", "onboarding", "active", "paused", "churned"].map((k) => ({
    key: k,
    label: k ? ({ churned: "Past" } as Record<string, string>)[k] ?? k[0].toUpperCase() + k.slice(1) : "All",
    href: `/clients${k ? `?lifecycle=${k}` : ""}`,
    count: k ? lifecycles.filter((l) => l === k).length : lifecycles.length,
  }));
  const list = (over: Record<string, unknown> = {}) =>
    h(ClientsByStatus, {
      tabs,
      fromServer: false,
      lifecycles,
      rows,
      head: h("thead", null, h("tr", null, h("th", null, "HEAD"))),
      empty: h("p", null, "EMPTY-STATE"),
      formFiltered: false,
      filterForm: h("form", null, "FILTER-FORM"),
      ...over,
    } as never);
  out.listAll = render(list(), "");
  out.listActive = render(list(), "lifecycle=active");
  out.listPaused = render(list(), "lifecycle=paused");
  out.listPausedFiltered = render(list({ formFiltered: true }), "lifecycle=paused");
  out.listNone = render(list({ lifecycles: [], rows: [] }), "");
  render(list(), "lifecycle=active");
  out.localPrefetch = links.map((l) => l.prefetch);
  out.localWarmHandlers = links.map((l) => typeof l.onMouseEnter === "function" || typeof l.onFocus === "function");
  routerCalls.length = 0;
  (globalThis as unknown as { window: unknown }).window = {
    history: { replaceState: (_s: unknown, _t: string, url: string) => void historyCalls.push(url) },
  };
  out.localClick = click("/clients?lifecycle=churned");
  out.localHistory = [...historyCalls];
  out.localRouter = [...routerCalls];
  // What the list shows once the address bar holds what the click wrote.
  out.listAfterClick = render(list(), new URL(historyCalls[0] ?? "/clients", "http://x").search.slice(1));

  // -- A mounted list: a click's rows show BEFORE the address bar moves -------
  // There is no DOM here, so the list is kept mounted the way React keeps a
  // component: its useState slots, by call order, carried from one render to
  // the next. Render on Active; click Past; render again with the address bar
  // NOT yet written (Next applies the click's replaceState a moment after the
  // click's own render); then with it written; then Back to Active from
  // outside. A list that read only the address bar would still show Active
  // rows in the click's own render.
  // The module object every component's `useState` is read from (loaded above).
  const reactCjs = require.cache[require.resolve("react")]!.exports as { useState: unknown };
  const realUseState = reactCjs.useState;
  const slots: unknown[] = [];
  let slot = 0;
  reactCjs.useState = (init: unknown) => {
    const i = slot++;
    if (!(i in slots)) slots[i] = typeof init === "function" ? (init as () => unknown)() : init;
    const set = (next: unknown) => {
      slots[i] = typeof next === "function" ? (next as (prev: unknown) => unknown)(slots[i]) : next;
    };
    return [slots[i], set];
  };
  const mounted = (url: string) => {
    slot = 0;
    return render(list(), url);
  };
  try {
    out.mountedStart = mounted("lifecycle=active");
    historyCalls.length = 0;
    routerCalls.length = 0;
    out.mountedClick = click("/clients?lifecycle=churned");
    out.mountedHistory = [...historyCalls];
    out.mountedRouter = [...routerCalls];
    out.mountedBeforeUrl = mounted("lifecycle=active");
    out.mountedUrlLanded = mounted("lifecycle=churned");
    out.mountedBack = mounted("lifecycle=active");
    out.mountedSlots = slots.length;
  } finally {
    reactCjs.useState = realUseState;
  }

  // A list cut at its page size: the rows are the server's, for the URL's status, and the tabs navigate.
  historyCalls.length = 0;
  const serverTabs = tabs.map((t) => ({ key: t.key, label: t.label, href: t.href }));
  out.server = render(
    list({ fromServer: true, tabs: serverTabs, lifecycles: ["prospect"], rows: [row("Charlie Prospect")] }),
    "lifecycle=prospect",
  );
  out.serverClick = click("/clients?lifecycle=active");
  out.serverHistory = [...historyCalls];
  links.find((l) => l.href === "/clients?lifecycle=active")?.onMouseEnter?.();
  out.serverWarm = [...routerCalls];

  // -- The filter form's status, and Clear ----------------------------------
  out.fieldActive = render(h(ClientStatusField), "lifecycle=active");
  out.fieldAll = render(h(ClientStatusField), "");
  out.clearNone = render(h(ClearClientFilters, { formFiltered: false }), "");
  out.clearStatus = render(h(ClearClientFilters, { formFiltered: false }), "lifecycle=paused");
  out.clearForm = render(h(ClearClientFilters, { formFiltered: true }), "");

  // -- The record header's "Write to client": not on the tab it opens -------
  out.writeOnOverview = render(h(WriteToClientLink, { customerId: "c1" }), "");
  out.writeOnConversations = render(h(WriteToClientLink, { customerId: "c1" }), "tab=conversations");

  process.stdout.write(JSON.stringify(out));
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
