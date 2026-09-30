/**
 * lib/playbook/live-sources.ts - the documents that render at read time from
 * what the live product uses (catalog source kind "app_live").
 *
 * Nothing here stores a body. Each renderer reads the same constants, tables
 * and builders the live surface reads, so the hub's text cannot drift from it:
 *   privacy_policy / terms / dmca   the public pages' own element trees
 *                                   (lib/playbook/element-markdown.ts)
 *   subprocessors                   lib/legal/constants.ts SUBPROCESSORS
 *   gst_qst_status                  the business entity's fin_settings row
 *   contract_*                      lib/contracts/templates.ts builders
 *   price_book                      lib/website-sales.ts packages and add-ons
 *   security_model                  lib/playbook/security-model.ts
 *
 * A source that cannot be read THROWS (LiveSourceError). The page says it
 * could not read the live source; it never shows "not registered" or an empty
 * table for a read that failed.
 */

import type { Client } from "@libsql/client";
import { createElement } from "react";
import PrivacyPage from "@/app/(marketing)/privacy/page";
import TermsPage from "@/app/(marketing)/terms/page";
import DmcaPage from "@/app/(marketing)/dmca/page";
import { LEGAL_EFFECTIVE_DATE, PRIVACY_LAST_UPDATED, SUBPROCESSORS } from "@/lib/legal/constants";
import { renderContract, type ContractRole } from "@/lib/contracts/templates";
import { BUSINESS_ENTITY_ID } from "@/lib/founders-finances/chart";
import { AUTOMATION_ADD_ONS, WEBSITE_PACKAGES } from "@/lib/website-sales";
import { SECURITY_MODEL_VERIFIED, securityModelMarkdown } from "./security-model";
import { elementToMarkdown } from "./element-markdown";
import { isoFromLongDate } from "./status";
import type { LiveSourceKey } from "./catalog";

export class LiveSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LiveSourceError";
  }
}

export type LiveDocument = {
  markdown: string;
  /** YYYY-MM-DD or ISO time the source last changed; null when the source records none. */
  sourceDate: string | null;
  /** Where the live copy is, as the viewer names it ("Live page /privacy"). */
  sourceLabel: string;
  /** Link to the live copy, for founders ("Open source"). Null when it has no page. */
  openHref: string | null;
};

type Meta = { sourceLabel: string; openHref: string | null; staticDate: string | null };

const CONTRACT_ROLE: Partial<Record<LiveSourceKey, ContractRole>> = {
  contract_opener: "opener",
  contract_closer: "closer",
  contract_manager: "manager",
  contract_builder: "builder",
};

export const LIVE_META: Readonly<Record<LiveSourceKey, Meta>> = {
  privacy_policy: { sourceLabel: "Live page /privacy", openHref: "/privacy", staticDate: isoFromLongDate(PRIVACY_LAST_UPDATED) },
  terms: { sourceLabel: "Live page /terms", openHref: "/terms", staticDate: isoFromLongDate(LEGAL_EFFECTIVE_DATE) },
  dmca: { sourceLabel: "Live page /dmca", openHref: "/dmca", staticDate: isoFromLongDate(LEGAL_EFFECTIVE_DATE) },
  subprocessors: { sourceLabel: "Privacy policy, section 6 (lib/legal/constants.ts)", openHref: "/privacy", staticDate: isoFromLongDate(PRIVACY_LAST_UPDATED) },
  gst_qst_status: { sourceLabel: "Finances settings", openHref: "/money", staticDate: null },
  contract_opener: { sourceLabel: "Contract builder (lib/contracts/templates.ts)", openHref: null, staticDate: null },
  contract_closer: { sourceLabel: "Contract builder (lib/contracts/templates.ts)", openHref: null, staticDate: null },
  contract_manager: { sourceLabel: "Contract builder (lib/contracts/templates.ts)", openHref: null, staticDate: null },
  contract_builder: { sourceLabel: "Contract builder (lib/contracts/templates.ts)", openHref: null, staticDate: null },
  price_book: { sourceLabel: "Website offer (lib/website-sales.ts)", openHref: "/playbook/deals", staticDate: null },
  security_model: { sourceLabel: "Security model (/playbook/security)", openHref: "/playbook/security", staticDate: SECURITY_MODEL_VERIFIED },
};

/** Contract placeholders are blanks a signer fills, not facts. */
const CONTRACT_BLANKS = {
  contractorName: "[Contractor legal name]",
  contractorEmail: "[Contractor email]",
  effectiveDate: "[Effective date]",
};

function subprocessorsMarkdown(): string {
  const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
  const rows = SUBPROCESSORS.map(
    (s) => `| ${esc(s.name)} | ${esc(s.role)} | ${esc(s.dataReceived)} | ${esc(s.region)} | ${s.dpaInPlace ? "In place" : "Not yet"} |`,
  );
  const gaps = SUBPROCESSORS.filter((s) => !s.dpaInPlace).map((s) => s.name);
  return [
    "# Sub-processor list",
    "",
    `Every processor that receives personal information from OASIS AI Solutions, as published in the privacy policy (last updated ${PRIVACY_LAST_UPDATED}).`,
    "",
    "| Processor | Role | Data received | Region | Data processing agreement |",
    "|---|---|---|---|---|",
    ...rows,
    "",
    gaps.length
      ? `Not yet in place: ${gaps.join(", ")}. Each is a compliance gap to close by accepting the provider's data processing terms in that account.`
      : "A data processing agreement is in place with every processor.",
    "",
  ].join("\n");
}

function priceBookMarkdown(): string {
  const packages = Object.values(WEBSITE_PACKAGES).map(
    (p) => `| ${p.name} | $${p.setupFloor.toLocaleString("en-CA")} | $${p.monthlyFloor.toLocaleString("en-CA")} | ${p.includedAutomationCount} | ${p.features.join("; ")} |`,
  );
  const addOns = AUTOMATION_ADD_ONS.map((a) => `- **${a.name}.** ${a.delivers}`);
  return [
    "# Website offer and price book",
    "",
    "The packages and floors the quote validator enforces (lib/website-sales.ts). Amounts are the floors per package; each deal records its own currency (CAD or USD).",
    "",
    "| Package | Setup floor | Monthly floor | Automations included | Includes |",
    "|---|---|---|---|---|",
    ...packages,
    "",
    "## Approved automation add-ons",
    "",
    ...addOns,
    "",
    "Anything not on this list is off the approved menu: route it to CC or Adon.",
    "",
  ].join("\n");
}

type GstRow = {
  legal_name: string;
  gst_qst_registered: number | string;
  gst_number: string;
  qst_number: string;
  registration_effective_date: string | null;
  updated_at: string;
};

/**
 * The business entity's settings: the row Finances itself uses
 * (BUSINESS_ENTITY_ID, lib/founders-finances/chart.ts), never "some row whose
 * kind is business". Anything but exactly one row is unknown, not a default.
 */
async function readBusinessSettings(db: Client): Promise<GstRow> {
  let rows: GstRow[];
  try {
    const rs = await db.execute({
      sql: `SELECT s.legal_name, s.gst_qst_registered, s.gst_number, s.qst_number, s.registration_effective_date, s.updated_at
            FROM fin_settings s JOIN fin_entities e ON e.id = s.entity_id
            WHERE s.entity_id = ? AND e.kind = 'business' LIMIT 2`,
      args: [BUSINESS_ENTITY_ID],
    });
    rows = rs.rows.map((r) => ({
      legal_name: String(r[0] ?? ""),
      gst_qst_registered: r[1] as number | string,
      gst_number: String(r[2] ?? ""),
      qst_number: String(r[3] ?? ""),
      registration_effective_date: r[4] === null || r[4] === undefined ? null : String(r[4]),
      updated_at: String(r[5] ?? ""),
    }));
  } catch (err) {
    console.error("[playbook.live.gst]", err);
    throw new LiveSourceError("The Finances settings could not be read, so the registration status is unknown.");
  }
  if (rows.length !== 1) {
    throw new LiveSourceError("Finances has no settings for the business yet, so the registration status is unknown.");
  }
  return rows[0];
}

/** The GST/QST facts the tax templates also use. */
export async function readGstQst(db: Client): Promise<{ registered: boolean; gstNumber: string; qstNumber: string; effectiveDate: string | null; legalName: string; updatedAt: string }> {
  const r = await readBusinessSettings(db);
  return {
    registered: Number(r.gst_qst_registered) === 1,
    gstNumber: r.gst_number,
    qstNumber: r.qst_number,
    effectiveDate: r.registration_effective_date,
    legalName: r.legal_name,
    updatedAt: r.updated_at,
  };
}

function gstMarkdown(g: Awaited<ReturnType<typeof readGstQst>>): string {
  const lines = ["# GST/QST registration status", "", `As recorded in Finances settings (last changed ${g.updatedAt || "at an unrecorded time"}).`, ""];
  if (g.registered) {
    lines.push(
      "**Registered for GST and QST.**",
      "",
      `- GST number: ${g.gstNumber || "Missing - needs CC: the GST number"}`,
      `- QST number: ${g.qstNumber || "Missing - needs CC: the QST number"}`,
      `- Effective: ${g.effectiveDate || "Missing - needs CC: the registration effective date"}`,
    );
  } else {
    lines.push(
      "**Not registered for GST or QST.**",
      "",
      "Invoices carry no GST or QST while the business is not registered. Registration becomes mandatory once taxable sales pass the small-supplier threshold over four consecutive calendar quarters; confirm the threshold and the date it was crossed with the accountant, and record the registration in Finances settings the day it is made.",
    );
  }
  lines.push("", `Legal name on invoices: ${g.legalName || "Missing - needs CC: the legal name"}`, "");
  return lines.join("\n");
}

/** The date a live source records without reading the database (null when it records none, or needs a read). */
export function liveStaticDate(key: LiveSourceKey): string | null {
  return LIVE_META[key].staticDate;
}

/** Render one live document. Throws LiveSourceError when its source cannot be read. */
export async function renderLiveSource(key: LiveSourceKey, db: Client | null): Promise<LiveDocument> {
  const meta = LIVE_META[key];
  const base = { sourceLabel: meta.sourceLabel, openHref: meta.openHref, sourceDate: meta.staticDate };
  switch (key) {
    case "privacy_policy":
      return { ...base, markdown: elementToMarkdown(createElement(PrivacyPage)) };
    case "terms":
      return { ...base, markdown: elementToMarkdown(createElement(TermsPage)) };
    case "dmca":
      return { ...base, markdown: elementToMarkdown(createElement(DmcaPage)) };
    case "subprocessors":
      return { ...base, markdown: subprocessorsMarkdown() };
    case "price_book":
      return { ...base, markdown: priceBookMarkdown() };
    case "security_model":
      return { ...base, markdown: securityModelMarkdown() };
    case "gst_qst_status": {
      if (!db) throw new LiveSourceError("The database is not configured, so the registration status is unknown.");
      const g = await readGstQst(db);
      return { ...base, sourceDate: g.updatedAt || null, markdown: gstMarkdown(g) };
    }
    default: {
      const role = CONTRACT_ROLE[key];
      if (!role) throw new LiveSourceError(`No live renderer for ${key}`);
      return { ...base, markdown: renderContract(role, CONTRACT_BLANKS) + "\n" };
    }
  }
}
