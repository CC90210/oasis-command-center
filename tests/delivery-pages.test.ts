/**
 * delivery-pages.test.ts — the four pages and the client portal, server side.
 * Run: node --conditions=react-server --import tsx tests/delivery-pages.test.ts
 *
 * Calls each page's server component with a real session against the local
 * libSQL harness and walks the element tree it returns (without rendering the
 * client components). Pins the page-level access rules the API test cannot
 * see: an OASIS non-founder is a 404 (the route does not admit it exists), a
 * client's pages carry only their own rows, and the portal lists the client's
 * projects and tickets.
 */
import "./_delivery-harness";
import assert from "node:assert/strict";
import { dirname } from "node:path";
import * as ReactNS from "react";
import { createElement, isValidElement, type ReactNode } from "react";
import { CLIENT_A, CLIENT_B, USERS, check, finish, login, setupDatabase } from "./_delivery-harness";

// tsconfig.json sets jsx:"preserve" for Next, so tsx compiles the pages' JSX
// with the classic runtime, which expects a global `React` (see
// tests/tsconfig.render.json for the same problem solved per-process).
(globalThis as unknown as { React: typeof ReactNS }).React = ReactNS;

// next/link is a client component that loads the browser router context, which
// does not exist under react-server. The pages only need it as an anchor.
const linkPath = require.resolve("next/link");
require.cache[linkPath] = {
  id: linkPath,
  filename: linkPath,
  path: dirname(linkPath),
  loaded: true,
  children: [],
  paths: [],
  exports: {
    __esModule: true,
    default: ({ href, children, ...rest }: { href: string; children?: ReactNode }) =>
      createElement("a", { href, ...rest }, children),
  },
} as unknown as NodeModule;

/** Every string reachable in an element tree, including props passed to client components. */
function textOf(node: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 60 || node === null || node === undefined || typeof node === "boolean") return out;
  if (typeof node === "string" || typeof node === "number") {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const n of node) textOf(n, out, depth + 1);
    return out;
  }
  if (isValidElement(node)) {
    const props = (node.props ?? {}) as Record<string, unknown>;
    // Render plain server function components (LoadError, Thread, badges) so
    // their text is visible. A client component calls hooks, which do not
    // exist under react-server and throw — for those, fall back to the props,
    // which are exactly what would be serialized to the browser.
    if (typeof node.type === "function") {
      try {
        const rendered = (node.type as (p: unknown) => unknown)(props);
        if (!(rendered instanceof Promise)) {
          textOf(rendered, out, depth + 1);
          return out;
        }
      } catch {
        /* client component: use its props below */
      }
    }
    for (const [k, v] of Object.entries(props)) {
      if (k === "children") textOf(v as ReactNode, out, depth + 1);
      else if (typeof v === "string") out.push(v);
      else if (v && typeof v === "object") textOf(JSON.stringify(v), out, depth + 1);
    }
    return out;
  }
  if (typeof node === "object") out.push(JSON.stringify(node));
  return out;
}

async function main() {
  const db = await setupDatabase();
  const store = await import("../lib/delivery/store");
  const now = new Date();
  const founder = { userId: USERS.cc.id, name: "CC" };
  const base = {
    description: null, category: "bug" as const, severity: "high" as const, source: "internal" as const,
    client_name: null, client_email: null, client_company: null, client_match: "manual", project_hint: null,
    reporter_user_id: null, assigned_to: null,
  };
  const pA = await store.createProject(db, {
    title: "ALPHA-PROJECT", description: null, client_tenant_id: CLIENT_A, client_name: null, client_email: null,
    lead_id: null, stage: "building", priority: "high", assigned_to: null, due_date: null,
  }, founder, now);
  const pB = await store.createProject(db, {
    title: "BRAVO-PROJECT", description: null, client_tenant_id: CLIENT_B, client_name: null, client_email: null,
    lead_id: null, stage: "review", priority: "low", assigned_to: null, due_date: null,
  }, founder, now);
  await store.addProjectUpdate(db, pA, { body: "ALPHA-SHARED-UPDATE", visibility: "client" }, founder, now);
  await store.addProjectUpdate(db, pA, { body: "ALPHA-INTERNAL-UPDATE", visibility: "internal" }, founder, now);
  const tA = (await store.createTicket(db, { ...base, title: "ALPHA-TICKET", project_id: pA, client_tenant_id: CLIENT_A }, now)).ticket;
  const tB = (await store.createTicket(db, { ...base, title: "BRAVO-TICKET", project_id: pB, client_tenant_id: CLIENT_B }, now)).ticket;
  await store.addTicketComment(db, tA.id, { body: "ALPHA-INTERNAL-NOTE", is_internal: true, author_type: "team", author: founder }, now);
  await store.addTicketComment(db, tA.id, { body: "ALPHA-PUBLIC-REPLY", is_internal: false, author_type: "team", author: founder }, now);

  const projects = (await import("../app/projects/page")).default;
  const project = (await import("../app/projects/[id]/page")).default;
  const tickets = (await import("../app/tickets/page")).default;
  const ticket = (await import("../app/tickets/[id]/page")).default;
  const portal = (await import("../app/client-portal/page")).default;
  const sp = Promise.resolve({});
  const text = async (el: Promise<unknown>) => textOf(await el).join("\n");
  const is404 = async (el: Promise<unknown>) => {
    try {
      await el;
      return false;
    } catch (err) {
      return /NEXT_HTTP_ERROR_FALLBACK;404/.test((err as Error).message);
    }
  };

  console.log("delivery-pages:");

  await login(USERS.cc);
  await check("founder: the board carries every client's projects and the queue every ticket", async () => {
    const board = await text(projects({ searchParams: sp }));
    assert.match(board, /ALPHA-PROJECT/);
    assert.match(board, /BRAVO-PROJECT/);
    const queue = await text(tickets({ searchParams: Promise.resolve({ status: "all" }) }));
    assert.match(queue, /ALPHA-TICKET/);
    assert.match(queue, /BRAVO-TICKET/);
  });
  await check("founder: a ticket page shows internal notes and public replies", async () => {
    const page = await text(ticket({ params: Promise.resolve({ id: tA.id }) }));
    assert.match(page, /ALPHA-INTERNAL-NOTE/);
    assert.match(page, /ALPHA-PUBLIC-REPLY/);
  });

  await login(USERS.rep);
  await check("an OASIS rep gets a 404 on every delivery page", async () => {
    assert.equal(await is404(projects({ searchParams: sp })), true);
    assert.equal(await is404(tickets({ searchParams: sp })), true);
    assert.equal(await is404(project({ params: Promise.resolve({ id: pA }) })), true);
    assert.equal(await is404(ticket({ params: Promise.resolve({ id: tA.id }) })), true);
  });

  await login(USERS.clientA);
  await check("client A: own project and ticket only; nothing internal", async () => {
    const board = await text(projects({ searchParams: sp }));
    assert.match(board, /ALPHA-PROJECT/);
    assert.doesNotMatch(board, /BRAVO-PROJECT/);
    const queue = await text(tickets({ searchParams: sp }));
    assert.match(queue, /ALPHA-TICKET/);
    assert.doesNotMatch(queue, /BRAVO-TICKET/);
    const detail = await text(project({ params: Promise.resolve({ id: pA }) }));
    assert.match(detail, /ALPHA-SHARED-UPDATE/);
    assert.doesNotMatch(detail, /ALPHA-INTERNAL-UPDATE/);
    const t = await text(ticket({ params: Promise.resolve({ id: tA.id }) }));
    assert.match(t, /ALPHA-PUBLIC-REPLY/);
    assert.doesNotMatch(t, /ALPHA-INTERNAL-NOTE/);
  });
  await check("client A: client B's project and ticket pages are 404", async () => {
    assert.equal(await is404(project({ params: Promise.resolve({ id: pB }) })), true);
    assert.equal(await is404(ticket({ params: Promise.resolve({ id: tB.id }) })), true);
  });
  await check("client portal: 'Your projects' and 'Your tickets' for client A only, with the report link", async () => {
    const page = await text(portal());
    assert.match(page, /Your projects/);
    assert.match(page, /ALPHA-PROJECT/);
    assert.match(page, /ALPHA-SHARED-UPDATE/, "the last client-visible update");
    assert.match(page, /ALPHA-TICKET/);
    assert.match(page, /ALPHA-PUBLIC-REPLY/, "the last public reply");
    assert.match(page, /\/f\/oasis-ai-cc\/support/);
    assert.doesNotMatch(page, /BRAVO-|ALPHA-INTERNAL/);
  });
  await login(USERS.cc);
  await check("client portal for a founder shows no delivery book at all", async () => {
    const page = await text(portal());
    assert.doesNotMatch(page, /ALPHA-PROJECT|BRAVO-PROJECT/);
  });

  // Last, because it breaks the schema: a failed read is an error on screen,
  // never an empty list — and the driver's text reaches founders, not clients.
  await db.execute("ALTER TABLE support_tickets RENAME TO support_tickets_gone");
  await check("a failed read renders an error, not 'no tickets'; only founders see the cause", async () => {
    await login(USERS.cc);
    const founderView = await text(tickets({ searchParams: sp }));
    assert.match(founderView, /Could not load/);
    assert.match(founderView, /no such table/);
    assert.doesNotMatch(founderView, /No open tickets/);
    await login(USERS.clientA);
    const clientView = await text(tickets({ searchParams: sp }));
    assert.match(clientView, /Could not load/);
    assert.doesNotMatch(clientView, /no such table|support_tickets/);
    const portalView = await text(portal());
    assert.match(portalView, /Could not load/);
    assert.doesNotMatch(portalView, /no such table/);
  });

  finish("delivery-pages");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
