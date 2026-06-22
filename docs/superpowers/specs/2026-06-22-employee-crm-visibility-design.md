# Per-employee CRM visibility, shared deals & live updates — design (2026-06-22)

## Context

SunBiz reps (Ezra, Jordan, Alex, + admin Matt) currently see **every** lead in the tenant, not just their own. Alex gets 10 leads from his personalized `?rep=alex` form link but the pipeline shows him 15 — including Jordan's 5 — causing overlap and confusion. CC wants true per-employee personalization: each agent sees only the leads/applications/deals **assigned to them** (or **shared** with them), ownership is transferable, and a reassignment shows up in the new owner's pipeline **live**. Deal-making sometimes pairs two agents (Alex+Jordan, Jordan+Ezra, etc.) — those deals must be visible to exactly the agents on them.

**Good news from exploration:** ~70% of this already exists (Adon Batch 2, 2026-06-19) and is simply turned **off**. This design *completes and activates* it, then adds the genuinely new pieces (shared deals + live updates).

## Decisions (CC, 2026-06-22)

1. **Admins = owner (CC) + Jordan + Matt** — see all leads + who they're assigned to. **Agents = Ezra + Alex** — see only their own + shared.
2. **Shared deals = a collaborators list** — one primary owner + any number of co-agents (supports the 2-agent pairings now, 3-way later, no rework).
3. **Live updates = Supabase Realtime broadcast nudge** — instant, carries no lead data, no table-RLS prerequisite.
4. **Scope coverage = leads + applications + funded deals** (renewals follow funded deals).
5. **Rollout = bulk-assign existing leads first, then flip the flag** — nothing vanishes.

## Current state (what already exists — reuse, don't rebuild)

- **`lib/lead-scope.ts`** — pure scope logic: `assigned_to` (auth_user_id, lowercased) on the record's jsonb `data`; `resolveAssignedScope(viewer, requested, enabled)`, `assignedWhere()`, `filterRowsByScope()`, `canViewLead()`, `leadScopingEnabled()` (reads `LEAD_SCOPING_ENABLED`, currently off → legacy "everyone sees all"), `NO_LEADS` fail-closed sentinel.
- **`lib/lead-access.ts`** — server-only single-record gates `getAccessibleLead` / `getAccessibleLeadTarget` (404 on deny, entity-aware lead/application).
- **`app/api/manifest/[slug]/records/[entity]/route.ts`** — GET already applies `resolveAssignedScope` for `SCOPED_ENTITIES = {lead, application}`; admin resolved from `user_profiles.is_owner || team_role in (admin, owner)`.
- **`app/t/[slug]/[...path]/page.tsx`** — the main lead/opportunity pipeline already passes `where: scopeWhere` to `listRecords` (lines ~826/829). **Already scoped.**
- **`app/api/leads/[id]/assign/route.ts`** — reassign: owner-or-admin gate, atomic `patch_tenant_record_data` RPC, audit row (`type: lead_reassigned`), accepts lead/application/funded_deal/renewal.
- **`lib/forms/agent-routing.ts`** — `resolveRepAssignment(tenant, ?rep)` stamps `assigned_to` on intake (Alex's `?rep=alex` link → lead owned by Alex). **Already works.**
- **`components/leads/AssignmentControl.tsx`** — the member-picker UI (reuse for the collaborator control).

## Design

### 1. Visibility model (one rule, server-enforced)

Canonical predicate, centralized in `lib/lead-scope.ts`:

```
canSee(viewer, record) =
  !enabled            // flag off → legacy: everyone sees all
  || viewer.isAdmin   // owner / Jordan / Matt
  || record.data.assigned_to === viewer.userId
  || (record.data.collaborators ?? []).includes(viewer.userId)
```

- **Admin set** is unchanged in mechanism (`is_owner || team_role ∈ {admin, owner}`). Action item: ensure Jordan + Matt have `team_role = admin`; Ezra + Alex are `member` (data step, part of rollout).
- Fail-closed: non-admin with no resolved `userId` → `NO_LEADS`.

### 2. Data model

- Add `data.collaborators: string[]` (auth_user_ids, lowercased) to lead / application / funded_deal records. Absent ⇒ `[]`. No schema migration needed (jsonb), but add a CHECK-style guard in the write path (array of UUIDs, max length cap e.g. 5).
- `assigned_to` stays the single **primary owner** (drives "My active deals", the assignee name, the next-steps email signer). Collaborators are additive viewers/workers, not the owner.

### 3. Extend scope from "owner only" → "owner OR collaborator"

- In `lib/lead-scope.ts`: extend `filterRowsByScope` and `canViewLead` to also match `collaborators.includes(viewer.userId)`. `resolveAssignedScope` stays for the admin/agent/unassigned axis.
- **DB-level OR:** the current `where: { assigned_to }` (simple eq) can't express "owner OR collaborator". Add a scoped query helper (in `lib/manifest/data.ts` or a new `lib/lead-scope-query.ts`) that, for a non-admin agent, issues a Supabase `.or("data->>assigned_to.eq.<id>,data->collaborators.cs.[\"<id>\"]")` containment query. Admin/unassigned paths keep the existing simple `where`. All list reads for scoped entities route through this helper so the OR logic lives in one place.

### 4. Close the wiring gaps (apply the scope everywhere leads render)

Already scoped: records API, main pipeline page, single-lead routes/drawer, lead detail.

To wire (pass the viewer = `{isAdmin, userId}` and apply the scoped query / `filterRowsByScope`):
- **`components/manifest/ManifestDashboard.tsx`** (primary gap, line ~82) — KPI counts (hot/missing/in-motion/funded), "most urgent leads", pipeline-glance counts, renewals. Resolve the viewer in its parent (`app/t/[slug]/page.tsx` `RootPageRenderer` already has `user` + tenant) and pass `{isAdmin, userId}` in; filter every list + count.
- **`components/manifest/ManifestTable.tsx` / `ManifestKanban.tsx`** (lines ~79/115) — the table/kanban view-toggle render paths; ensure they receive + apply the scope (the pipeline_entity path already does, but the generic toggle may not).
- **`app/pipeline/page.tsx`** (line ~114) and **`components/sunbiz/SunBizDashboard.tsx`** (`getLeadsForTenant`, line ~175) — scope or confirm not in SunBiz agents' path.
- Single source of truth: each surface calls the same scoped query / filter helper from §3.

### 5. Shared-deal UI (collaborators)

- In **`LeadDetailDrawer.tsx`**, beside the existing Assignment control, add an **"Add collaborator"** control reusing `AssignmentControl`'s member picker (multi-select, shows current collaborators as removable chips).
- New endpoint **`POST /api/leads/[id]/collaborators`** (mirror the assign route's owner-or-admin gate + `patch_tenant_record_data` merge + audit row): `{ add?: userId, remove?: userId }`. Validates the user is a tenant member; caps array length. Owner or admin may edit collaborators; a collaborator cannot add/remove others (only owner/admin).
- Reassigning the owner does **not** clear collaborators.

### 6. Live updates — Realtime broadcast nudge

- **Channel:** per-user `board:<auth_user_id>` (Supabase Realtime **broadcast**, not postgres_changes — so no table RLS needed, and no lead data crosses the wire).
- **Emit (server):** in the assign + collaborators + lead-create paths, after the write, broadcast `{ event: "board_changed" }` to every affected user's channel: the new owner, the previous owner (so it leaves their board), and each added/removed collaborator. Use the server Supabase client's `channel(...).send({type:"broadcast", event:"board_changed"})`.
- **Receive (client):** a small client component (e.g. `components/leads/BoardLiveRefresh.tsx`) mounted in the dashboard + pipeline shell subscribes to `board:<myUserId>` and calls `router.refresh()` on message (debounced ~500ms). The server re-renders the viewer's already-scoped board → the reassigned lead appears/disappears within seconds, no manual reload.
- Degrades gracefully: if Realtime is unavailable, the next navigation/refresh still shows correct (scoped) state.

### 7. Rollout (bulk-assign first, then flip)

1. Set `team_role` so Jordan + Matt = admin, Ezra + Alex = member.
2. Use/confirm the bulk-assign tool to distribute currently-unassigned leads/applications/funded_deals to the right reps (admin-only "Select mode" already exists per Batch hardening).
3. Set `LEAD_SCOPING_ENABLED=true` in Vercel (production). Verify each role sees the right board.
4. New inbound leads auto-tag via `?rep=` (already working), so the assigned bucket stays populated.

**Sequencing:** §4 (scoping completeness across all surfaces) MUST land before the flag flip in step 3 — otherwise flipping caps agents on some surfaces but leaks on others. §5 (collaborators) and §6 (live updates) are additive and can land before or shortly after the flip; landing both *before* the flip gives the full experience on day one and is preferred. Suggested phases for the plan: **P1** scope completeness + bulk-assign + roles → **P2** collaborators → **P3** live broadcast → flip flag once P1 (min) is verified → **P4 (later, separate)** RLS hardening.

### 8. Security hardening (recommended follow-on — NOT in this spec's scope)

Scoping is app-layer (service-role bypasses RLS); a single missed surface leaks. A later dedicated phase should add **RLS on `tenant_records`** scoped by assigned_to/collaborators/admin as the real backstop. Sequenced after this ships; not coupled in (it would balloon scope + risk).

## Out of scope
- RLS on tenant_records (separate hardening phase).
- Reworking the funded_deals table vs tenant_records funded_deal divergence (pre-existing; note only).
- The AI chat agent's lead reads (`lib/agent-context.ts`, `agent-actions.ts`) — different trust model; revisit separately.
- Changing the assignment/ownership semantics beyond adding collaborators.

## Testing / verification
- Unit: extend `tests/lead-scope.test.ts` + `tests/employee-scoped-pipeline.test.ts` for the collaborator OR (owner sees; collaborator sees; non-member doesn't; admin sees all; fail-closed).
- Integration: records-API + dashboard counts scoped per viewer; collaborators endpoint owner-or-admin gate; assign emits broadcast.
- Manual (prod after rollout): Alex sees only Alex's; assign Alex→Jordan, Jordan's board updates live; add Ezra as collaborator on Alex's deal → both see it, Jordan (non-collab agent) doesn't; admin (Jordan/Matt) sees all.
- `npm run typecheck && npm run lint && npm run build` green before each push; ship to `main` (production).
- Rule 8: Codex independent audit of the access-control changes before declaring done (this is security-sensitive).

## Risks
- **Fail-closed flag flip** with undistributed leads → empty boards. Mitigated by §7 ordering (bulk-assign before flip).
- **Missed render surface** = leak. Mitigated by routing all reads through one scoped helper + the RLS follow-on.
- **Realtime auth**: broadcast channels should be per-user; confirm channel naming can't be subscribed cross-user to spoof a refresh (low impact — a nudge carries no data, worst case a spurious refresh).
