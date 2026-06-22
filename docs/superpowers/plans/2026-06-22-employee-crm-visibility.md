# Per-employee CRM Visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans (inline) or subagent-driven-development. Steps use `- [ ]`.

**Goal:** Each SunBiz agent sees only their own + shared leads/applications/funded-deals; admins see all; reassignment + collaborators update the right boards live.

**Architecture:** Complete + activate the dormant single-owner scope (`lib/lead-scope.ts`, gated by `LEAD_SCOPING_ENABLED`); extend the predicate from "owner only" → "owner OR collaborator"; route every list read through one scoped query; add a `data.collaborators[]` dimension + UI + endpoint; push live updates via a Supabase Realtime **broadcast nudge** to per-user channels.

**Tech Stack:** Next.js 15 App Router, Supabase (tenant_records jsonb), TypeScript, tsx tests.

## Global Constraints
- Scope applies to entities: **lead, application, funded_deal** (renewal follows funded_deal). Other entities tenant-shared.
- Admin = `user_profiles.is_owner || team_role ∈ {admin, owner}` (owner CC + Jordan + Matt). Agents = Ezra, Alex.
- Fail-closed: non-admin, unresolved identity → no rows (`NO_LEADS`).
- All scope logic centralized in `lib/lead-scope.ts`; every surface calls it — never re-implement the predicate.
- `assigned_to` + `collaborators` entries are lowercased auth_user_ids. Collaborators cap = 5.
- Ship to `main` (Vercel prod), committer `214530671+CC90210@users.noreply.github.com`, explicit `git add`.
- Security-sensitive: Rule 8 Codex audit before declaring done. `tsc && lint && build` green before each push.

---

## P1 — Scope completeness + roles + rollout

### Task 1: Extend the scope predicate for collaborators
**Files:** Modify `lib/lead-scope.ts`; Test `tests/lead-scope.test.ts`.
**Produces:** `recordMatchesViewer(data, viewer, enabled): boolean` (canonical predicate); `normalizeCollaborators(data): string[]`; `COLLABORATORS_KEY = "collaborators"`. Extends `filterRowsByScope` + `canViewLead` to use it.
- [ ] Add `normalizeCollaborators` (reads `data.collaborators`, returns lowercased string[] or []) + `recordMatchesViewer` = `!enabled || viewer.isAdmin || owner===userId || collaborators.includes(userId)`.
- [ ] Rewrite `filterRowsByScope` to honor a `viewer` (owner OR collaborator) in addition to the existing admin-filter `scope` param — keep the admin agent/unassigned narrowing working. `canViewLead` delegates to `recordMatchesViewer`.
- [ ] Tests: owner sees; collaborator sees; non-member doesn't; admin sees all; flag-off sees all; fail-closed; collaborator + unassigned-admin-filter interplay.
- [ ] Run `npx tsx tests/lead-scope.test.ts`; commit.

### Task 2: Owner-OR-collaborator list query + funded_deal scoping
**Files:** Modify `lib/manifest/data.ts` (listRecords), `app/api/manifest/[slug]/records/[entity]/route.ts`; Test `tests/employee-scoped-pipeline.test.ts`.
**Consumes:** Task 1. **Produces:** `ListRecordsInput.ownerOrCollaborator?: string` → builds `q.or(\`data->>assigned_to.eq.${id},data->collaborators.cs.["${id}"]\`)` (replaces the simple assigned_to `where` for agents). Admin paths keep `where`.
- [ ] Add `ownerOrCollaborator` to `ListRecordsInput`; in listRecords, when set, apply the `.or()` containment (UUID-validate the id first to avoid injection into the filter string). Keep `where` for admin agent/unassigned/all.
- [ ] In the records route: add `funded_deal` to `SCOPED_ENTITIES`; for a non-admin agent pass `ownerOrCollaborator: user.id`; for admins keep `assignedWhere(scope)`.
- [ ] Tests: agent list returns owned + collaborated, excludes others; admin returns all; funded_deal scoped.
- [ ] Run tests; `tsc`; commit.

### Task 3: Scope the dashboard (the main gap)
**Files:** Modify `components/manifest/ManifestDashboard.tsx`, `app/t/[slug]/page.tsx` (RootPageRenderer passes viewer).
**Consumes:** Task 1 (`filterRowsByScope`/`recordMatchesViewer`), `leadScopingEnabled`.
- [ ] In `RootPageRenderer` (already has `user` + tenant) resolve `{ isAdmin, userId }` (reuse the records-route admin check: is_owner||team_role∈{admin,owner}) and pass to `ManifestDashboard`.
- [ ] In `ManifestDashboard`, after fetching `rowsByEntity`, filter `lead`, `application`, `funded_deal` arrays through `filterRowsByScope(rows, viewer)` (when scoping enabled) BEFORE computing: SunBizHeroKpis counts, TopUrgentLeads, PipelineGlanceCard counts, RenewalsDueSoon. So every count + list reflects the viewer's book.
- [ ] Verify admin sees full numbers; agent sees only theirs. `tsc`; commit.

### Task 4: Scope remaining read surfaces
**Files:** `components/manifest/ManifestTable.tsx`, `components/manifest/ManifestKanban.tsx`, `app/pipeline/page.tsx`, `components/sunbiz/SunBizDashboard.tsx` (+ `app/t/[slug]/[...path]/page.tsx:1036` audit).
- [ ] For each surface that lists lead/application/funded_deal: thread viewer scope (pass `ownerOrCollaborator` to listRecords for agents, or `filterRowsByScope` for already-fetched rows). The pipeline_entity path (826/829) already scopes — confirm the generic table/kanban toggle for those entities also does.
- [ ] `app/pipeline/page.tsx` + `SunBizDashboard`: scope or confirm not in a SunBiz agent's nav path; if reachable by agents, apply scope.
- [ ] `tsc`; commit.

### Task 5: Roles + bulk-assign + flag (rollout prep)
**Files:** verify `app/api/leads/bulk/route.ts` (bulk assign exists); data step (SQL) for roles; doc the env flag.
- [ ] Confirm bulk-assign supports assigning many leads to a rep (owner-or-admin gated). If a gap, add `assigned_to` to the bulk action.
- [ ] Data step (run at rollout, not code): `user_profiles.team_role='admin'` for Jordan + Matt; `'member'` for Ezra + Alex (via supabase_tool.py). Document exact UUIDs at run time.
- [ ] Do NOT set `LEAD_SCOPING_ENABLED=true` until P1 verified + leads distributed.

---

## P2 — Collaborators (shared deals)

### Task 6: Collaborators endpoint
**Files:** Create `app/api/leads/[id]/collaborators/route.ts`; Test `tests/collaborators-endpoint.test.ts` (logic-level).
**Produces:** `POST {add?: userId, remove?: userId}` → owner-or-admin gate (mirror assign route), member-of-tenant check, cap 5, atomic `patch_tenant_record_data` merge of `collaborators`, audit row (`type: collaborator_changed`). Returns `{ ok, collaborators }`.
- [ ] Mirror `assign/route.ts`: session + UUID validate + read record + owner-or-admin gate (owner = assigned_to or admin; a collaborator may NOT edit collaborators). Validate add/remove user is a tenant member. Merge array (dedupe, lowercase, cap), reject if would exceed 5. Audit.
- [ ] Tests: owner adds; admin adds; non-owner agent 404; non-member rejected; cap enforced; remove works.
- [ ] `tsc`; commit.

### Task 7: Collaborators UI in the drawer
**Files:** Create `components/leads/CollaboratorsControl.tsx`; Modify `components/leads/LeadDetailDrawer.tsx`.
- [ ] Mirror `AssignmentControl`: fetch `/api/team/members`, render current collaborators as removable chips + an "Add collaborator" select (exclude the current owner + existing collaborators). POST to `/api/leads/[id]/collaborators`. Optimistic; `onSaved` re-fetches drawer.
- [ ] Mount in `LeadDetailDrawer` beside the Assignment control (drawer already renders AssignmentControl). Pass current collaborators from the detail payload (extend `/api/leads/[id]/detail` to include `data.collaborators` if not already returned).
- [ ] `tsc`; commit.

---

## P3 — Live broadcast nudge

### Task 8: Server broadcast helper + wire to mutations
**Files:** Create `lib/realtime/board-nudge.ts`; Modify `app/api/leads/[id]/assign/route.ts`, `app/api/leads/[id]/collaborators/route.ts`, the lead-create path (`app/api/forms/submit` + `lib/applications/create-from-lead.ts`).
**Produces:** `nudgeBoards(userIds: (string|null)[]): Promise<void>` — for each distinct non-null userId, `getServiceSupabase().channel(\`board:${id}\`).send({ type: "broadcast", event: "board_changed", payload: {} })`. Best-effort (never throws into the caller).
- [ ] Implement helper (dedupe, skip null, swallow errors).
- [ ] assign route: after write, `nudgeBoards([previousOwner, nextAssignedTo])`.
- [ ] collaborators route: after write, `nudgeBoards([owner, addedOrRemovedUserId])`.
- [ ] lead-create (rep-assigned intake): after create, `nudgeBoards([assigned_to])`.
- [ ] `tsc`; commit.

### Task 9: Client live-refresh subscriber
**Files:** Create `components/leads/BoardLiveRefresh.tsx`; mount in `components/MainShell.tsx` (or the dashboard + pipeline shells); ensure a browser Supabase client exists (`lib/supabase-browser.ts` — create if absent).
- [ ] Client component: resolve current `auth_user_id` (from a prop or `/api/me`), subscribe to `board:<id>` broadcast; on `board_changed` call `router.refresh()` debounced ~600ms. Unsubscribe on unmount.
- [ ] Mount once in the authenticated shell so it covers dashboard + pipeline. Pass the viewer's auth_user_id from the server layout.
- [ ] Manual smoke: two browsers (Alex, Jordan); reassign Alex→Jordan → Jordan's board refreshes within seconds.
- [ ] `tsc`; commit.

---

## Flip + verify (Task 10)
- [ ] `npm run typecheck && npm run lint && npm run build` green.
- [ ] Run `tests/lead-scope.test.ts`, `tests/employee-scoped-pipeline.test.ts`, new tests.
- [ ] Rule 8: Codex independent audit of the access-control diff (focus: any surface still unscoped = leak; the `.or()` injection-safety; owner-or-admin gates; collaborator cap).
- [ ] Push P1–P3 to `main` (Vercel deploys). Verify production build Ready.
- [ ] Rollout: set roles, bulk-assign existing leads, then set `LEAD_SCOPING_ENABLED=true` in Vercel. Re-verify each role's board.

## Self-review (spec coverage)
- Visibility model → Task 1. Admin set → Tasks 2/3. Scope surfaces → Tasks 2/3/4. Collaborators data+query → Tasks 1/2/6. Collaborators UI → Task 7. Live updates → Tasks 8/9. Rollout → Tasks 5/10. RLS hardening → out of scope (spec §8). Funded-deal coverage → Task 2. All spec sections mapped.
