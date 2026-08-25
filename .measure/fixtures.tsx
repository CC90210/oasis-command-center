/**
 * Permanent synthetic fixtures for the geometry harness. No real merchant,
 * no real lead. Names are chosen to be LONG on purpose: the whole point of
 * the harness is to find the width floor, and the floor is set by the
 * longest content, not the average.
 */
import type { WebLeadRow } from "@/lib/web-leads/data";
import type { Facets } from "@/lib/web-leads/queries";

const base = {
  address: "1200 Rue Sainte-Catherine Ouest",
  postal: "H3B 1K1",
  territoryId: null,
  territoryName: null,
  osmCategory: "restaurant",
  firstSeen: "2026-01-04T00:00:00.000Z",
  openingHoursRaw: null,
  openingHours: null,
  openingHoursCheckedAt: null,
  openingHoursSource: null,
  assignedTo: null,
  released: false,
  lastCallAt: null,
  auditFindings: "Checked 49 things on this site.",
};

export const LEADS: WebLeadRow[] = [
  {
    ...base,
    id: "fixture-0001",
    // Deliberately one of the longest plausible Canadian business names.
    name: "Restaurant Le Vieux Continental Brasserie et Bar a Vin de Montreal",
    phone: "+1-905-812-2229",
    city: "Saint-Jean-sur-Richelieu",
    province: "QC",
    industry: "Restaurants & Bars",
    websiteUrl: "https://example-fixture-one.test",
    websiteCondition: "Has a site, not yet reviewed",
    score: 34,
    scoreState: "scored",
    stage: "attempting_contact",
  },
  {
    ...base,
    id: "fixture-0002",
    name: "Bob's Plumbing",
    phone: "+1-416-259-9326",
    city: "Toronto",
    province: "ON",
    industry: "Plumbing",
    websiteUrl: null,
    websiteCondition: "No website found yet, needs checking",
    score: null,
    scoreState: "no_website",
    stage: "researched",
    released: true,
  },
  {
    ...base,
    id: "fixture-0003",
    name: "Northern Lights Hair Studio & Spa",
    phone: "+1-867-979-1234",
    city: "Iqaluit",
    province: "NU",
    industry: "Hair & Beauty",
    websiteUrl: "https://example-fixture-three.test",
    websiteCondition: "Has a site, not yet reviewed",
    score: 100,
    scoreState: "scored",
    stage: "connected",
  },
  {
    ...base,
    id: "fixture-0004",
    name: "Groupe Immobilier Tremblay",
    phone: null,
    city: "Quebec",
    province: "QC",
    industry: "Real Estate",
    websiteUrl: "https://example-fixture-four.test",
    websiteCondition: "Has a site, not yet reviewed",
    score: null,
    scoreState: "unreachable",
    stage: "qualified",
  },
];

export const FACETS: Facets = {
  provinces: [
    { code: "ON", count: 12043, cities: [{ name: "Toronto", count: 4120 }, { name: "Ottawa", count: 980 }, { name: "Mississauga", count: 610 }] },
    { code: "QC", count: 9021, cities: [{ name: "Montreal", count: 3300 }, { name: "Saint-Jean-sur-Richelieu", count: 210 }] },
    { code: "BC", count: 5110, cities: [{ name: "Vancouver", count: 2100 }] },
    { code: "AB", count: 3980, cities: [{ name: "Calgary", count: 1500 }] },
    { code: "NU", count: 44, cities: [{ name: "Iqaluit", count: 44 }] },
  ],
  industries: [
    { name: "Restaurants & Bars", count: 6210 },
    { name: "Hair & Beauty", count: 4880 },
    { name: "Plumbing", count: 2310 },
    { name: "Automotive Repair & Service", count: 1990 },
    { name: "Real Estate", count: 1440 },
  ],
  totalCallable: 31034,
};
