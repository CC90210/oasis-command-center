# Projects, Tickets and the Client Support form

**Status:** built on `feat/delivery-tickets`, not deployed. Needs migration 183 applied and the SLA cron scheduled (see "What needs a founder" below).
**Code:** `lib/delivery/` (rules, access, store, intake, notifications, SLA), `app/api/projects/**`, `app/api/tickets/**`, `app/api/cron/sla-check`, `app/projects/**`, `app/tickets/**`, `app/client-portal/page.tsx`, one branch in `app/api/forms/submit/route.ts`.
**Tests:** `npm run test:delivery` (in CI).
**Migration:** `database/turso/183_delivery_and_support.turso.sql`.

---

## Why this was rebuilt

The tables behind /projects and /tickets were never created: their SQL sat in `database/176-178_*.sql`, outside `database/turso/`, so nothing applied it. Both pages caught the "no such table" error and showed "No projects yet". `GET /api/tickets` let any signed-in user of any workspace list every ticket. The SLA cron wrote to a column `agent_events` does not have. Forms never created tickets, and the client portal showed ROI only.

## Data model

Every row belongs to the OASIS workspace: `tenant_id` is always `ef8d389e-3f15-43f2-ae00-3660f69a1452` (slug `oasis-ai-cc`). A row may name a client in two ways:

| Column | Meaning |
|---|---|
| `client_tenant_id` | A hosted client with its own portal workspace. Users signed in to that workspace see this row. |
| `client_name`, `client_email` | A client with no portal. The email is stored lowercased; the support form matches on it. |

| Table | What it holds |
|---|---|
| `delivery_projects` | One engagement. `stage` is discovery, building, review, live, maintenance or paused. Also priority, assignee, due date, `started_at`, `launched_at`, `archived_at`, optional `lead_id` (the OASIS pipeline lead it came from). |
| `delivery_tasks` | Internal work items on a project. Clients never see them. `status` is todo, in_progress, blocked, done or cancelled. There is no delete: a mistaken task is cancelled. |
| `delivery_updates` | The project timeline. `visibility` is `internal` by default; only `client` updates reach the portal. |
| `support_tickets` | `ticket_number` (T-0001, unique per workspace), category, severity, status, source (form, portal, internal), optional project link, client fields, `sla_target` / `first_response_at` / `sla_breached_at`, attachments, and a claim + outcome column pair for each notification. |
| `ticket_comments` | The thread. `author_type` is client, team or system. `is_internal` defaults to 1, so a comment is public only when it was written as a reply. `email_status` records whether a reply reached the client. |
| `provisioning_runs` | Unchanged from 176 (read by `lib/client-provisioning.ts` and the onboarding wizard). No new UI. |

The migration also seeds the **Client Support Ticket** form (`forms` row, OASIS workspace, slug `support`) once, and never overwrites a later edit made in the form builder.

There are no CHECK constraints on the enum columns. The allowed values live once, in `lib/delivery/rules.ts`, and every write is validated there first. SQLite cannot change a CHECK without rebuilding the table.

## Who sees what

Decided in one place, `lib/delivery/access.ts`, and applied as SQL by `lib/delivery/store.ts`:

| Viewer | Gets |
|---|---|
| Founder (persona `founder` in the OASIS workspace: CC, Adon) | Everything in the workspace, every action. |
| Anyone signed in to another workspace | Only rows whose `client_tenant_id` is their workspace. Client-safe fields only (an allowlist), public comments only, client-visible updates only, no tasks. They can file a ticket for their own workspace and reply on their own tickets. Another client's ticket or project is a 404. |
| OASIS non-founders (reps, builders, marketing) | Refused (the pages 404, the API returns 403). |

The third row is a deliberate default, not an oversight: project and ticket data names every client and their problems, and no persona below founder has been granted that. If assigned builders should see their own projects, that is a decision to make (see below).

## Flows

**Support form** (`/f/oasis-ai-cc/support`). The public form posts to `/api/forms/submit` like every form. One early branch sends an anonymous submission to exactly this workspace and slug into `lib/delivery/support-intake.ts`, which returns before the route's lead creation, uploads, stage moves or drip hooks. No other form is affected; the check is a string comparison with no query. The intake:

1. checks the form exists, is enabled and has exactly one step (it refuses loudly otherwise);
2. validates the answers;
3. stores the optional screenshot in the private `support-attachments` bucket under the ticket id;
4. records a `form_submissions` row whose `lead_id` is `ticket:<ticket id>`, because there is no lead;
5. matches the client by email, server-side only: one active project with that client email links the project and its workspace; otherwise portal users of exactly one workspace link that workspace; otherwise nothing;
6. creates the ticket, keyed on the submission id so it can never be created twice;
7. after the response: Telegram and email to the founders, and a confirmation email to the client with the ticket number. Each is claimed on the ticket before it is sent, so it happens once.

The client confirmation repeats only the ticket number, category, priority and a sanitised first name. The form does not verify email addresses, so anything else echoed back could be a stranger's text sent under the OASIS name.

**Team replies.** On a ticket, "Send reply to client" emails the client from the OASIS mailbox and, if it is the first public reply, stops the first-response clock. "Add internal note" does neither. The email outcome is shown on the reply.

**Client replies** reopen a ticket that was waiting on them or resolved, and ping the founders' Telegram. A closed ticket takes no more client replies.

**SLA.** First response is due in 1 hour (critical), 4 hours (high), 24 hours (medium) or 72 hours (low) from creation. Changing severity on an unanswered ticket re-targets it. `/api/cron/sla-check` flags unanswered open tickets past their target, alerts the founders once per breach, and re-drives any support submission whose request died before its ticket or notifications were created.

## Environment variables (names only)

| Variable | Used for |
|---|---|
| `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` | All delivery reads and writes. |
| `OASIS_MAIL_FROM`, `OASIS_MAIL_APP_PASSWORD` | The OASIS mailbox for client confirmations, replies and founder emails (or the `oasis_gmail` tenant credential). Without them every email is recorded as FAILED on the ticket. |
| `OASIS_TELEGRAM_BOT_TOKEN`, `OASIS_TELEGRAM_CHAT_ID` | Founder alerts (operator lane; falls back to `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID`). |
| `R2_ACCOUNT_ID` (or `CLOUDFLARE_ACCOUNT_ID`) and the other `R2_*` storage variables | Support attachments. Without them an attachment is refused and the ticket says so. |
| `CRON_SECRET`, plus `CRON_ATTEST_SECRET` on Cloudflare | The SLA cron's auth. |
| `BRAVO_DASHBOARD_URL` (or the other public-origin variables `publicAppBaseUrl()` reads) | Ticket links in founder alerts. |

## What needs a founder

1. **Apply migration 183** to live Turso. It was dry-run against live and applied to a throwaway database only.
2. **Schedule the SLA cron.** Add `/api/cron/sla-check` to `workers/oasis-cc-cron/src/index.ts` (every 15 minutes). Until then breaches are shown on the pages but nobody is alerted, and a support submission that dies half-way is not re-driven.
3. **Confirm the OASIS mailbox is configured** in production, or client confirmations and replies will not send (each failure is visible on the ticket).
4. **Link clients to projects.** A support request is matched to a project only when the project's client email matches the email the client types, or when the client has portal users in exactly one workspace.
5. **Decide whether non-founders get access.** Today builders and reps cannot open Projects or Tickets, even when work is assigned to them.
6. **Nav.** `/projects` and `/tickets` are in the OASIS nav. A client workspace whose manifest falls back to the OASIS nav will see them too, which is intended: those pages show a client only their own rows.

## Known limits

- The anonymous form page does not prefill from the URL, so "Report an issue" cannot fill in the client's email.
- A reply emailed by a client lands in the OASIS mailbox, not on the ticket thread. There is no inbound email to ticket link.
- A form link minted with a lead token (the Forms "mint link" action) would bypass the support branch and behave like a normal form. Share the plain `/f/oasis-ai-cc/support` link only.
- The form must stay one step.
