/**
 * lib/skills/admin.ts - the gate for every /api/skills admin route (JARVIS plan 2).
 * OASIS workspace + founder persona, else 404 (the F0 rule: never confirm it exists);
 * writes must be same-origin (CSRF). Ownership is applied by the store, from viewer.userId.
 */
import "server-only";
import type { Client } from "@libsql/client";
import type { NextResponse } from "next/server";
import { crossOrigin, json, notFoundJson, requireDocsViewer, sameOrigin } from "@/lib/playbook/http";
import type { DocsViewer } from "@/lib/playbook/viewer";
import { skillsDb } from "./store";

export async function requireSkillsAdmin(req: Request | null, write: boolean): Promise<
  { ok: true; viewer: DocsViewer; db: Client } | { ok: false; response: NextResponse }
> {
  const who = await requireDocsViewer();
  if (!who.ok) return who;
  if (!who.viewer.founder) return { ok: false, response: notFoundJson() };
  if (write && (!req || !sameOrigin(req))) return { ok: false, response: crossOrigin() };
  const db = skillsDb();
  if (!db) return { ok: false, response: json({ ok: false, error: "storage_not_ready" }, 503) };
  return { ok: true, viewer: who.viewer, db };
}
