/**
 * Booking settings persistence (migration 227, table booking_settings).
 *
 * One JSON document per workspace, parsed by lib/booking/hours.ts. A stored
 * document that no longer parses FAILS LOUD (booking_settings_invalid): the
 * public calendar then offers nothing, never hours nobody chose. A workspace
 * with no row gets the built-in OASIS default (CC's hours, 2026-10-16); any
 * other workspace is not configured for public booking.
 *
 * Saves are compare-and-swap on `version` so two editors cannot silently
 * overwrite each other. ASCII only.
 */

import "server-only";
import type { Client } from "@libsql/client";
import { AI_AUDIT_TENANT_ID } from "@/lib/forms/oasis-ai-audit-seed";
import { getTursoClient } from "@/lib/turso";
import { getOasisPipelineAssignmentRoster, OASIS_PIPELINE_ASSIGNMENT_EMAILS, type MemberRow } from "@/lib/team";
import { defaultOasisBookingSettings, parseBookingSettings, type BookingSettings } from "./hours";

export class BookingSettingsError extends Error {
  constructor(readonly code: string, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "BookingSettingsError";
  }
}

export type LoadedBookingSettings = {
  settings: BookingSettings;
  /** 0 = nothing saved yet (the built-in default is in use). */
  version: number;
  saved: boolean;
};

export type BookingHostIdentity = { userId: string; email: string; displayName: string };

export type BookingSettingsDeps = {
  db?: Client;
  roster?: (tenantId: string) => Promise<MemberRow[]>;
};

function isMissingTable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /no such table/i.test(message);
}

let warnedMissingTable = false;

async function readRow(db: Client, tenantId: string): Promise<{ doc: string; version: number } | null> {
  try {
    const rs = await db.execute({
      sql: "SELECT doc, version FROM booking_settings WHERE tenant_id = ? LIMIT 1",
      args: [tenantId],
    });
    const row = rs.rows[0];
    if (!row) return null;
    return { doc: String(row.doc ?? ""), version: Number(row.version ?? 0) };
  } catch (error) {
    // Migration 227 not applied yet: behave as "nothing saved" so the built-in
    // default keeps booking working; say so once per isolate.
    if (isMissingTable(error)) {
      if (!warnedMissingTable) {
        warnedMissingTable = true;
        console.error("[booking.settings] table missing: apply database/turso/bravo__227_booking_settings.sql");
      }
      return null;
    }
    throw new BookingSettingsError("booking_settings_read_failed", error instanceof Error ? error.message : String(error));
  }
}

/** The people who may host booked calls in this workspace: the OASIS sales roster. */
export async function bookingRoster(tenantId: string, deps: BookingSettingsDeps = {}): Promise<MemberRow[]> {
  if (tenantId !== AI_AUDIT_TENANT_ID) return [];
  return (deps.roster ?? getOasisPipelineAssignmentRoster)(tenantId);
}

export function hostIdentities(roster: MemberRow[]): Map<string, BookingHostIdentity> {
  const out = new Map<string, BookingHostIdentity>();
  for (const member of roster) {
    const userId = member.auth_user_id?.trim();
    if (!userId) continue;
    out.set(userId, {
      userId,
      email: member.email.trim().toLowerCase(),
      displayName: (member.display_name || member.full_name || member.email).trim(),
    });
  }
  return out;
}

function defaultSettings(roster: MemberRow[]): BookingSettings {
  const byEmail = new Map(roster.map((m) => [m.email.trim().toLowerCase(), m.auth_user_id?.trim() || ""]));
  const organizer = byEmail.get(OASIS_PIPELINE_ASSIGNMENT_EMAILS[0]) || "";
  if (!organizer) throw new BookingSettingsError("public_booking_founders_unavailable");
  return defaultOasisBookingSettings({ organizerUserId: organizer, attendeeUserId: null });
}

export async function loadBookingSettings(tenantId: string, deps: BookingSettingsDeps = {}): Promise<LoadedBookingSettings> {
  const db = deps.db ?? getTursoClient();
  const row = await readRow(db, tenantId);
  if (row) {
    const settings = parseBookingSettings(row.doc);
    if (!settings) throw new BookingSettingsError("booking_settings_invalid");
    return { settings, version: row.version, saved: true };
  }
  if (tenantId !== AI_AUDIT_TENANT_ID) throw new BookingSettingsError("booking_not_configured");
  return { settings: defaultSettings(await bookingRoster(tenantId, deps)), version: 0, saved: false };
}

export type SaveBookingSettingsResult =
  | { ok: true; version: number }
  | { ok: false; error: "version_conflict"; version: number | null };

/**
 * Save compare-and-swap. `expectedVersion` is the version the editor read
 * (0 when nothing was saved yet). The caller has already parsed `settings`.
 */
export async function saveBookingSettings(input: {
  tenantId: string;
  settings: BookingSettings;
  expectedVersion: number;
  actorUserId: string;
  now?: Date;
  db?: Client;
}): Promise<SaveBookingSettingsResult> {
  const db = input.db ?? getTursoClient();
  const doc = JSON.stringify(input.settings);
  const at = (input.now ?? new Date()).toISOString();
  const rs = input.expectedVersion === 0
    ? await db.execute({
        sql: `INSERT INTO booking_settings (tenant_id, doc, version, updated_at, updated_by)
              VALUES (?, ?, 1, ?, ?) ON CONFLICT (tenant_id) DO NOTHING`,
        args: [input.tenantId, doc, at, input.actorUserId],
      })
    : await db.execute({
        sql: `UPDATE booking_settings SET doc = ?, version = version + 1, updated_at = ?, updated_by = ?
              WHERE tenant_id = ? AND version = ?`,
        args: [doc, at, input.actorUserId, input.tenantId, input.expectedVersion],
      });
  if (rs.rowsAffected === 1) return { ok: true, version: input.expectedVersion + 1 };
  const current = await readRow(db, input.tenantId);
  return { ok: false, error: "version_conflict", version: current ? current.version : null };
}
