/**
 * components/os/department/inbound-rules.ts - the Sales tab's "Inbound leads"
 * tile, pure (no database, no server-only) so its wording is unit-tested.
 *
 * The Sales board is the cold-prospecting book. Leads that arrive through the
 * oasisai.work forms live in the warm-inbound queue, which that board never
 * counts, so this tile is where a founder opening Sales sees them.
 */
import type { KpiTileProps } from "@/components/os/KpiTile";

/** The warm-inbound queue's figures: how many, and how far along. */
export type InboundFigures = { total: number; untouched: number; booked: number };

/** Where the tile's action goes: the queue itself. */
export const INBOUND_QUEUE_HREF = "/pipeline?motion=inbound";

const n = (v: number) => v.toLocaleString("en-US");

/**
 * Null: this viewer has no warm-inbound scope, so no tile is drawn (a number
 * from a narrower scope would be a different number than the queue shows).
 */
export function inboundTiles(
  read: { ok: true; value: InboundFigures } | { ok: false } | null,
): KpiTileProps[] {
  if (read === null) return [];
  if (!read.ok) return [{ label: "Inbound leads", value: null, status: "error", hint: "Lead read failed" }];
  const { total, untouched, booked } = read.value;
  if (total === 0) {
    return [{ label: "Inbound leads", value: null, status: "no_data", emptyText: "None yet", hint: "From the website forms" }];
  }
  return [
    {
      label: "Inbound leads",
      value: n(total),
      status: "live",
      hint: `${n(untouched)} untouched · ${n(booked)} booked`,
      action: { label: "Open Warm inbound", href: INBOUND_QUEUE_HREF },
    },
  ];
}
