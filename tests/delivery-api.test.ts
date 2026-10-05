/**
 * delivery-api.test.ts — the Projects + Tickets API, driven for real.
 * Run: node --conditions=react-server --import tsx tests/delivery-api.test.ts
 *
 * Real route handlers, real session resolution (signed cookie -> profile ->
 * persona), real SQL against a local libSQL file carrying migration 183. Pins:
 *
 *   - the GET /api/tickets hole is closed: an OASIS rep gets 403, a client
 *     gets only their own workspace's tickets, nobody signed out gets anything;
 *   - a client can never read another client's ticket or project (404, not
 *     403 — the route must not confirm it exists), never sees internal
 *     comments, internal updates or tasks, and cannot write internal notes or
 *     change a ticket;
 *   - every assignment goes through the live roster: a deactivated teammate or
 *     a stranger is refused on projects, tasks and tickets;
 *   - linking a ticket to another client's project is refused.
 */
import "./_delivery-harness";
import assert from "node:assert/strict";
import { CLIENT_A, CLIENT_B, USERS, check, finish, login, setupDatabase } from "./_delivery-harness";

type Json = Record<string, unknown>;

async function main() {
  const db = await setupDatabase();
  const { NextRequest } = await import("next/server");
  const projects = await import("../app/api/projects/route");
  const project = await import("../app/api/projects/[id]/route");
  const tasks = await import("../app/api/projects/[id]/tasks/route");
  const task = await import("../app/api/projects/[id]/tasks/[taskId]/route");
  const updates = await import("../app/api/projects/[id]/updates/route");
  const tickets = await import("../app/api/tickets/route");
  const ticket = await import("../app/api/tickets/[id]/route");
  const comments = await import("../app/api/tickets/[id]/comments/route");

  const req = (method: string, url: string, body?: unknown) =>
    new NextRequest(`http://localhost${url}`, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const call = async (p: Promise<Response>) => {
    const res = await p;
    return { status: res.status, body: (await res.json()) as Json };
  };
  const params = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) });

  console.log("delivery-api:");

  // ── founders build the fixture through the API itself ──────────────────
  await login(USERS.cc);
  const pa = await call(projects.POST(req("POST", "/api/projects", {
    title: "Client A website", client_tenant_id: CLIENT_A, client_name: "Alice", client_email: "OWNER@client-a.test",
    stage: "building", assigned_to: USERS.adon.id,
  })));
  const pb = await call(projects.POST(req("POST", "/api/projects", {
    title: "Client B automation", client_tenant_id: CLIENT_B, stage: "discovery",
  })));
  const projectA = String(pa.body.id);
  const projectB = String(pb.body.id);

  await check("founder creates projects (201) with a roster assignee", async () => {
    assert.equal(pa.status, 201, JSON.stringify(pa.body));
    assert.equal(pb.status, 201, JSON.stringify(pb.body));
    const p = pa.body.project as Json;
    assert.equal(p.assigned_to, USERS.adon.id);
    assert.equal(p.client_email, "owner@client-a.test");
    assert.ok(p.started_at, "a project created in Building has started");
  });

  const ta = await call(tickets.POST(req("POST", "/api/tickets", {
    title: "A: checkout broken", severity: "critical", category: "bug", project_id: projectA,
  })));
  const tb = await call(tickets.POST(req("POST", "/api/tickets", {
    title: "B: question", severity: "low", client_tenant_id: CLIENT_B,
  })));
  const ticketA = String(ta.body.id);
  const ticketB = String(tb.body.id);
  await check("founder files internal tickets; a ticket on A's project inherits client A", async () => {
    assert.equal(ta.status, 201, JSON.stringify(ta.body));
    const t = ta.body.ticket as Json;
    assert.equal(t.client_tenant_id, CLIENT_A);
    assert.equal(t.ticket_number, "T-0001");
    assert.equal((tb.body.ticket as Json).ticket_number, "T-0002");
  });

  await call(comments.POST(req("POST", `/api/tickets/${ticketA}/comments`, { body: "INTERNAL-NOTE: client is on the old plan" }), params({ id: ticketA })));
  await call(updates.POST(req("POST", `/api/projects/${projectA}/updates`, { body: "INTERNAL-UPDATE: margin is thin" }), params({ id: projectA })));
  await call(updates.POST(req("POST", `/api/projects/${projectA}/updates`, { body: "Homepage draft is ready for review", visibility: "client" }), params({ id: projectA })));
  await call(tasks.POST(req("POST", `/api/projects/${projectA}/tasks`, { title: "INTERNAL-TASK: fix DNS" }), params({ id: projectA })));

  // ── the GET /api/tickets authorization hole ─────────────────────────────
  await login(null);
  await check("signed out: 401 on every read", async () => {
    assert.equal((await call(tickets.GET(req("GET", "/api/tickets")))).status, 401);
    assert.equal((await call(projects.GET(req("GET", "/api/projects")))).status, 401);
  });
  await login(USERS.rep);
  await check("an OASIS rep (not a founder) is refused, not handed the whole queue", async () => {
    const r = await call(tickets.GET(req("GET", "/api/tickets?status=all")));
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.equal("tickets" in r.body, false);
    assert.equal((await call(projects.GET(req("GET", "/api/projects")))).status, 403);
    assert.equal((await call(ticket.GET(req("GET", `/api/tickets/${ticketA}`), params({ id: ticketA })))).status, 403);
  });

  // ── client A ────────────────────────────────────────────────────────────
  await login(USERS.clientA);
  await check("client A lists only client A's tickets, with client-safe fields", async () => {
    const r = await call(tickets.GET(req("GET", "/api/tickets?status=all")));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const list = r.body.tickets as Json[];
    assert.deepEqual(list.map((t) => t.id), [ticketA]);
    assert.equal("assigned_to" in list[0], false);
    assert.equal("client_match" in list[0], false);
  });
  await check("client A cannot read client B's ticket or project: 404, no body leak", async () => {
    const t = await call(ticket.GET(req("GET", `/api/tickets/${ticketB}`), params({ id: ticketB })));
    assert.equal(t.status, 404);
    assert.equal(JSON.stringify(t.body).includes("B: question"), false);
    const p = await call(project.GET(req("GET", `/api/projects/${projectB}`), params({ id: projectB })));
    assert.equal(p.status, 404);
  });
  await check("client A's own ticket thread hides internal notes", async () => {
    const r = await call(ticket.GET(req("GET", `/api/tickets/${ticketA}`), params({ id: ticketA })));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const body = JSON.stringify(r.body);
    assert.equal(body.includes("INTERNAL-NOTE"), false, "internal note leaked");
    assert.equal(body.includes("Linked to project"), false, "system note leaked");
  });
  await check("client A's project shows client-visible updates only, and no tasks", async () => {
    const r = await call(project.GET(req("GET", `/api/projects/${projectA}`), params({ id: projectA })));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const body = JSON.stringify(r.body);
    assert.equal(body.includes("INTERNAL-UPDATE"), false);
    assert.equal(body.includes("INTERNAL-TASK"), false);
    assert.equal("tasks" in r.body, false);
    assert.equal(body.includes("Homepage draft is ready"), true);
    assert.equal("assigned_to" in (r.body.project as Json), false);
    assert.equal((r.body.project as Json).last_client_update_body, "Homepage draft is ready for review");
  });
  await check("client A cannot comment on client B's ticket (404) nor write an internal note", async () => {
    const other = await call(comments.POST(req("POST", `/api/tickets/${ticketB}/comments`, { body: "hi" }), params({ id: ticketB })));
    assert.equal(other.status, 404);
    const mine = await call(comments.POST(req("POST", `/api/tickets/${ticketA}/comments`, { body: "Still broken", is_internal: true }), params({ id: ticketA })));
    assert.equal(mine.status, 201, JSON.stringify(mine.body));
    const row = await db.execute({ sql: "SELECT is_internal, author_type FROM ticket_comments WHERE body = 'Still broken'", args: [] });
    assert.equal(Number(row.rows[0].is_internal), 0, "a client comment is always public");
    assert.equal(row.rows[0].author_type, "client");
  });
  await check("client A cannot PATCH a ticket, create a project, task or update", async () => {
    assert.equal((await call(ticket.PATCH(req("PATCH", `/api/tickets/${ticketA}`, { status: "closed" }), params({ id: ticketA })))).status, 403);
    assert.equal((await call(projects.POST(req("POST", "/api/projects", { title: "mine" })))).status, 403);
    assert.equal((await call(tasks.POST(req("POST", `/api/projects/${projectA}/tasks`, { title: "x" }), params({ id: projectA })))).status, 403);
    assert.equal((await call(updates.POST(req("POST", `/api/projects/${projectA}/updates`, { body: "x", visibility: "client" }), params({ id: projectA })))).status, 403);
  });
  await check("a client-filed ticket is pinned to THEIR workspace, whatever the body claims", async () => {
    const r = await call(tickets.POST(req("POST", "/api/tickets", {
      title: "Portal ticket", client_tenant_id: CLIENT_B, assigned_to: USERS.cc.id, project_id: projectB,
    })));
    assert.equal(r.status, 400, "naming another client's project is refused");
    const ok = await call(tickets.POST(req("POST", "/api/tickets", { title: "Portal ticket", client_tenant_id: CLIENT_B, assigned_to: USERS.cc.id })));
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    const row = (await db.execute({ sql: "SELECT client_tenant_id, assigned_to, source, client_email FROM support_tickets WHERE id = ?", args: [String(ok.body.id)] })).rows[0];
    assert.equal(row.client_tenant_id, CLIENT_A);
    assert.equal(row.assigned_to, null);
    assert.equal(row.source, "portal");
    assert.equal(row.client_email, "owner@client-a.test");
  });

  // ── client B sees none of A ─────────────────────────────────────────────
  await login(USERS.clientB);
  await check("client B's list and projects contain only client B", async () => {
    const t = await call(tickets.GET(req("GET", "/api/tickets?status=all")));
    assert.deepEqual((t.body.tickets as Json[]).map((x) => x.id), [ticketB]);
    const p = await call(projects.GET(req("GET", "/api/projects")));
    assert.deepEqual((p.body.projects as Json[]).map((x) => x.id), [projectB]);
  });

  // ── assignee validation, everywhere ─────────────────────────────────────
  await login(USERS.adon);
  await check("assigning a DEACTIVATED teammate is refused on tickets, projects and tasks", async () => {
    const t = await call(ticket.PATCH(req("PATCH", `/api/tickets/${ticketA}`, { assigned_to: USERS.gone.id }), params({ id: ticketA })));
    assert.equal(t.status, 400, JSON.stringify(t.body));
    assert.equal(t.body.error, "assignee_not_on_roster");
    const p = await call(project.PATCH(req("PATCH", `/api/projects/${projectA}`, { assigned_to: USERS.gone.id }), params({ id: projectA })));
    assert.equal(p.body.error, "assignee_not_on_roster");
    const k = await call(tasks.POST(req("POST", `/api/projects/${projectA}/tasks`, { title: "x", assigned_to: USERS.gone.id }), params({ id: projectA })));
    assert.equal(k.body.error, "assignee_not_on_roster");
  });
  await check("assigning someone outside the roster (a client user) is refused", async () => {
    const t = await call(ticket.PATCH(req("PATCH", `/api/tickets/${ticketA}`, { assigned_to: USERS.clientA.id }), params({ id: ticketA })));
    assert.equal(t.body.error, "assignee_not_on_roster");
  });
  await check("an active rep is assignable; the thread records it internally", async () => {
    const t = await call(ticket.PATCH(req("PATCH", `/api/tickets/${ticketA}`, { assigned_to: USERS.rep.id }), params({ id: ticketA })));
    assert.equal(t.status, 200, JSON.stringify(t.body));
    assert.equal((t.body.ticket as Json).assigned_to, USERS.rep.id);
    const note = await db.execute({ sql: "SELECT body, is_internal FROM ticket_comments WHERE ticket_id = ? AND author_type = 'system' ORDER BY created_at DESC LIMIT 1", args: [ticketA] });
    assert.match(String(note.rows[0].body), /Assigned to David/);
    assert.equal(Number(note.rows[0].is_internal), 1);
  });
  await check("task status and assignee update through the roster", async () => {
    const list = await call(project.GET(req("GET", `/api/projects/${projectA}`), params({ id: projectA })));
    const taskId = String(((list.body.tasks as Json[])[0]).id);
    const r = await call(task.PATCH(req("PATCH", `/api/projects/${projectA}/tasks/${taskId}`, { status: "done", assigned_to: USERS.cc.id }), params({ id: projectA, taskId })));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const row = (await db.execute({ sql: "SELECT status, completed_at, assigned_to FROM delivery_tasks WHERE id = ?", args: [taskId] })).rows[0];
    assert.equal(row.status, "done");
    assert.ok(row.completed_at);
    assert.equal(row.assigned_to, USERS.cc.id);
    const other = await call(task.PATCH(req("PATCH", `/api/projects/${projectB}/tasks/${taskId}`, { status: "todo" }), params({ id: projectB, taskId })));
    assert.equal(other.status, 404, "a task is only reachable through its own project");
  });

  // ── ticket <-> project linking and status rules ─────────────────────────
  await check("linking client B's ticket to client A's project is refused", async () => {
    const r = await call(ticket.PATCH(req("PATCH", `/api/tickets/${ticketB}`, { project_id: projectA }), params({ id: ticketB })));
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.error, "project_belongs_to_another_client");
  });
  await check("status moves follow the transition table; closed only reopens", async () => {
    const closed = await call(ticket.PATCH(req("PATCH", `/api/tickets/${ticketB}`, { status: "closed" }), params({ id: ticketB })));
    assert.equal(closed.status, 200, JSON.stringify(closed.body));
    assert.ok((closed.body.ticket as Json).closed_at);
    const bad = await call(ticket.PATCH(req("PATCH", `/api/tickets/${ticketB}`, { status: "resolved" }), params({ id: ticketB })));
    assert.equal(bad.status, 409);
    assert.equal(bad.body.error, "invalid_transition");
  });
  await check("a closed ticket takes no more client comments", async () => {
    await login(USERS.clientB);
    const r = await call(comments.POST(req("POST", `/api/tickets/${ticketB}/comments`, { body: "hello?" }), params({ id: ticketB })));
    assert.equal(r.status, 409);
    assert.equal(r.body.error, "ticket_closed");
  });
  await check("a public team reply stops the SLA clock; an internal note does not", async () => {
    await login(USERS.cc);
    const before = (await db.execute({ sql: "SELECT first_response_at FROM support_tickets WHERE id = ?", args: [ticketA] })).rows[0];
    assert.equal(before.first_response_at, null, "internal notes must not count as a response");
    const r = await call(comments.POST(req("POST", `/api/tickets/${ticketA}/comments`, { body: "Looking now.", is_internal: false }), params({ id: ticketA })));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.first_response, true);
    // No OASIS mailbox in this environment: the outcome is recorded, not hidden.
    assert.match(String((r.body.comment as Json).email_status), /FAILED/);
    const after = (await db.execute({ sql: "SELECT first_response_at FROM support_tickets WHERE id = ?", args: [ticketA] })).rows[0];
    assert.ok(after.first_response_at);
  });
  await check("the client sees the public reply as the last reply on their list", async () => {
    await login(USERS.clientA);
    const r = await call(tickets.GET(req("GET", "/api/tickets?status=all")));
    const mine = (r.body.tickets as Json[]).find((t) => t.id === ticketA)!;
    assert.equal(mine.last_public_reply_body, "Looking now.");
  });

  finish("delivery-api");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
