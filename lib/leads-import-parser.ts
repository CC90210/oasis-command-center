export type ParsedLeadImportRow = {
  name: string | null;
  email: string | null;
  phone: string | null;
  company: string | null;
  source: string | null;
  notes: string | null;
  business_name: string | null;
  contact_name: string | null;
  stage: string | null;
  state: string | null;
  monthly_revenue: string | null;
  paper_grade: string | null;
  time_in_business: string | null;
  assigned_to: string | null;
  date_submitted: string | null;
  lender_list: string | null;
  dba: string | null;
  business_address: string | null;
  business_city: string | null;
  business_zip: string | null;
  website: string | null;
  website_condition: string | null;
  audit_findings: string | null;
  icp_track: string | null;
  entity_type: string | null;
  record_type: string | null;
  industry: string | null;
  title: string | null;
  ownership_pct: string | null;
  product_service: string | null;
  annual_revenue: string | null;
  requested_amount: string | null;
  application_url: string | null;
  bank_statement_urls: string | null;
  dl_vc_urls: string | null;
};

export type LeadImportField = keyof ParsedLeadImportRow;

export type LeadImportParseResult = {
  headers: string[];
  rows: string[][];
  mapped: ParsedLeadImportRow[];
  colMap: Array<LeadImportField | null>;
  headerRowIndex: number;
  skippedPreambleRows: number;
  skippedNoiseRows: number;
  sectionLabels: string[];
};

export const LEADS_IMPORT_SAMPLE = `Business Name,Owner,Email,Phone,State,Monthly Revenue,Stage,Source,Notes
Velocity Logistics LLC,Carlos Mejia,carlos@velocity-log.com,(214) 555-0118,TX,48000,Hot Lead,linkedin_outreach,Roofing co - 18 months
Reyes Motors,Mike Reyes,mike@reyesmotors.net,(727) 555-9911,FL,72000,Missing Info,referral,Used cars dealer
Pinnacle HVAC,Renee Patterson,renee@pinnaclehvac.com,(484) 555-0149,GA,31000,Sent Application,csv,Needs 4th statement
`;

function normalizeHeader(h: string): string {
  return h.trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export function mapLeadImportHeader(header: string): LeadImportField | null {
  const n = normalizeHeader(header);
  switch (n) {
    case "name":
    case "fullname":
      return "name";
    case "business":
    case "businessname":
    case "legal":
    case "legalname":
    case "legalbusinessname":
    case "company":
    case "companyname":
      return "business_name";
    case "contact":
    case "contactname":
    case "owner":
    case "ownername":
    case "merchant":
    case "merchantname":
    case "signer":
    case "signername":
    case "primarycontact":
      return "contact_name";
    case "email":
    case "emailaddress":
    case "eaddress":
      return "email";
    case "phone":
    case "phonenumber":
    case "businessphone":
    case "cell":
    case "mobile":
    case "tel":
      return "phone";
    case "source":
    case "leadsource":
    case "channel":
      return "source";
    case "notes":
    case "note":
    case "comment":
    case "comments":
    case "bodyforemailshopping":
    case "emailshoppingbody":
    case "shoppingnotes":
      return "notes";
    case "stage":
    case "pipelinestage":
    case "leadstage":
    case "phase":
    case "pipelinephase":
    case "group":
    case "section":
    case "boardsection":
    case "status":
      return "stage";
    case "state":
    case "businessstate":
    case "region":
    case "province":
      return "state";
    case "revenue":
    case "monthlyrevenue":
    case "monthlyrev":
    case "revmo":
    case "avgmonthlyrevenue":
    case "monthlyrevenueusd":
      return "monthly_revenue";
    case "annualrevenue":
    case "yearlyrevenue":
      return "annual_revenue";
    case "requestedadvanceamount":
    case "requestedamount":
    case "amountrequested":
    case "advanceamount":
    case "fundingamount":
      return "requested_amount";
    case "paper":
    case "papergrade":
    case "grade":
      return "paper_grade";
    case "timeinbusiness":
    case "tib":
    case "monthsinbusiness":
    case "lengthofownership":
      return "time_in_business";
    case "assignedto":
    case "agent":
    case "owneruser":
      return "assigned_to";
    case "datesubmitted":
    case "submittedat":
    case "createdat":
      return "date_submitted";
    case "lenderlist":
    case "lenders":
    case "lenderslist":
      return "lender_list";
    case "dba":
    case "doingbusinessas":
      return "dba";
    case "businessstreetaddress":
    case "businessaddress":
    case "streetaddress":
      return "business_address";
    case "businesscity":
      return "business_city";
    case "businesszip":
    case "businesszipcode":
    case "businesspostalcode":
      return "business_zip";
    case "website":
    case "url":
    case "businesswebsite":
      return "website";
    case "websitecondition":
    case "sitecondition":
      return "website_condition";
    case "auditfindings":
    case "websiteaudit":
      return "audit_findings";
    case "icptrack":
    case "prospecttrack":
    case "vertical":
      return "icp_track";
    case "typeofentity":
    case "entitytype":
      return "entity_type";
    case "recordtype":
    case "recordentity":
    case "rowtype":
    case "objecttype":
    case "crmtype":
      return "record_type";
    case "typeofbusiness":
    case "businesstype":
    case "industry":
      return "industry";
    case "title":
    case "merchanttitle":
      return "title";
    case "ownership":
    case "ownershippct":
    case "ownershippercent":
      return "ownership_pct";
    case "productservicesold":
    case "productservice":
    case "servicesold":
      return "product_service";
    case "application":
    case "applicationurl":
    case "app":
      return "application_url";
    case "bankstatements":
    case "statements":
      return "bank_statement_urls";
    case "dlvc":
    case "dlvoidedcheck":
    case "driverslicensevoidedcheck":
    case "driverslicense":
    case "voidedcheck":
      return "dl_vc_urls";
    default:
      return null;
  }
}

function emptyRow(): ParsedLeadImportRow {
  return {
    name: null,
    email: null,
    phone: null,
    company: null,
    source: null,
    notes: null,
    business_name: null,
    contact_name: null,
    stage: null,
    state: null,
    monthly_revenue: null,
    paper_grade: null,
    time_in_business: null,
    assigned_to: null,
    date_submitted: null,
    lender_list: null,
    dba: null,
    business_address: null,
    business_city: null,
    business_zip: null,
    website: null,
    website_condition: null,
    audit_findings: null,
    icp_track: null,
    entity_type: null,
    record_type: null,
    industry: null,
    title: null,
    ownership_pct: null,
    product_service: null,
    annual_revenue: null,
    requested_amount: null,
    application_url: null,
    bank_statement_urls: null,
    dl_vc_urls: null,
  };
}

function trimTrailingEmpty(cells: string[]): string[] {
  const copy = cells.map((c) => c.trim());
  while (copy.length && !copy[copy.length - 1]) copy.pop();
  return copy;
}

function isBlankRow(cells: string[]): boolean {
  return cells.every((c) => !c.trim());
}

function recognitionCount(cells: string[]): number {
  return cells.map(mapLeadImportHeader).filter(Boolean).length;
}

function headerScore(cells: string[]): number {
  const mapped = cells.map(mapLeadImportHeader);
  const count = mapped.filter(Boolean).length;
  if (count < 3) return 0;
  const hasIdentity =
    mapped.includes("business_name") ||
    mapped.includes("name") ||
    mapped.includes("email") ||
    mapped.includes("phone");
  if (!hasIdentity) return 0;
  let score = count;
  if (mapped.includes("stage")) score += 3;
  if (mapped.includes("email")) score += 2;
  if (mapped.includes("phone")) score += 2;
  if (mapped.includes("monthly_revenue")) score += 2;
  return score;
}

function findHeaderRow(rows: string[][]): number {
  let bestIndex = rows.length ? 0 : -1;
  let bestScore = 0;
  const limit = Math.min(rows.length, 500);
  for (let i = 0; i < limit; i++) {
    const cells = trimTrailingEmpty(rows[i] || []);
    if (isBlankRow(cells)) continue;
    const score = headerScore(cells);
    if (score > bestScore) {
      bestScore = score;
      bestIndex = i;
      if (score >= 16) break;
    }
  }
  return bestIndex;
}

function sectionLabel(cells: string[]): string | null {
  const clean = trimTrailingEmpty(cells);
  if (clean.length !== 1) return null;
  const value = clean[0];
  if (!value || value.length > 80) return null;
  if (mapLeadImportHeader(value)) return null;
  return value;
}

function isRepeatedHeader(cells: string[], recognizedHeaderCount: number): boolean {
  const count = recognitionCount(cells);
  return count >= Math.max(3, Math.min(8, recognizedHeaderCount));
}

function hasMeaningfulLeadSignal(row: ParsedLeadImportRow): boolean {
  return Boolean(
    row.business_name ||
      row.company ||
      row.name ||
      row.contact_name ||
      row.email ||
      row.phone,
  );
}

export function parseCsvMatrix(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      row.push(field);
      field = "";
      if (!isBlankRow(row)) out.push(row);
      row = [];
      if (c === "\r" && text[i + 1] === "\n") i++;
    } else {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    if (!isBlankRow(row)) out.push(row);
  }
  return out;
}

export function parseLeadImportCsv(text: string): LeadImportParseResult {
  const matrix = parseCsvMatrix(text);
  const headerRowIndex = findHeaderRow(matrix);
  if (headerRowIndex < 0) {
    return {
      headers: [],
      rows: [],
      mapped: [],
      colMap: [],
      headerRowIndex: -1,
      skippedPreambleRows: 0,
      skippedNoiseRows: 0,
      sectionLabels: [],
    };
  }

  const headers = matrix[headerRowIndex] || [];
  const colMap = headers.map(mapLeadImportHeader);
  const recognized = colMap.filter(Boolean).length;
  const rows = matrix.slice(headerRowIndex + 1);
  const mapped: ParsedLeadImportRow[] = [];
  const sections = new Set<string>();
  let currentSection: string | null = null;
  let skippedNoiseRows = headerRowIndex;

  for (const rawCells of rows) {
    const cells = trimTrailingEmpty(rawCells);
    if (isBlankRow(cells)) {
      skippedNoiseRows += 1;
      continue;
    }

    const section = sectionLabel(cells);
    if (section) {
      currentSection = section;
      sections.add(section);
      skippedNoiseRows += 1;
      continue;
    }

    if (isRepeatedHeader(cells, recognized)) {
      skippedNoiseRows += 1;
      continue;
    }

    const row = emptyRow();
    cells.forEach((val, idx) => {
      const fieldKey = colMap[idx];
      const clean = (val || "").trim();
      if (!fieldKey || !clean) return;
      if (fieldKey === "notes" && row.notes) {
        row.notes = `${row.notes}\n${clean}`;
        return;
      }
      if (!row[fieldKey]) row[fieldKey] = clean;
    });

    if (!row.stage && currentSection) row.stage = currentSection;
    if (!row.business_name && row.dba) row.business_name = row.dba;
    if (!row.company && row.business_name) row.company = row.business_name;

    if (!hasMeaningfulLeadSignal(row)) {
      skippedNoiseRows += 1;
      continue;
    }
    mapped.push(row);
  }

  return {
    headers,
    rows,
    mapped,
    colMap,
    headerRowIndex,
    skippedPreambleRows: headerRowIndex,
    skippedNoiseRows,
    sectionLabels: Array.from(sections),
  };
}
