/**
 * lib/playbook/regulatory.ts - the few statements of law the business
 * documents repeat, written once so the live GST/QST document and the tax
 * calendar template cannot say different things.
 *
 * Each rule is stated completely or not at all: a founder relies on these
 * documents, and a half rule (the four-quarter test without the single-quarter
 * one) is the rule that misses the quarter that matters. Where the timing
 * depends on facts only the accountant has, the sentence says to confirm it
 * with them instead of guessing.
 */

import { SMALL_SUPPLIER_THRESHOLD_CENTS } from "@/lib/founders-finances/tax";

// Grouped by hand, not toLocaleString: the text must not depend on the
// runtime's locale data.
const threshold = `CA$${String(SMALL_SUPPLIER_THRESHOLD_CENTS / 100).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;

/**
 * The GST/QST small-supplier test (Excise Tax Act s.148; the QST Act mirrors
 * it; lib/founders-finances/tax.ts tracks it). Both triggers: one calendar
 * quarter on its own, or the last four consecutive calendar quarters.
 */
export const SMALL_SUPPLIER_RULE =
  `Registration becomes mandatory when worldwide taxable sales pass the ${threshold} small-supplier threshold ` +
  "in a single calendar quarter, or over the last four consecutive calendar quarters; zero-rated sales to clients " +
  "outside Canada count toward it. The date registration applies from differs between the two cases: confirm it " +
  "with the accountant.";

/**
 * Who must register with the Registraire des entreprises du Quebec (Act
 * respecting the legal publicity of enterprises, s.21): a general partnership
 * formed in Quebec whatever its name, and a sole proprietor only when trading
 * under a name that does not include their own surname and given name.
 */
export const ENTERPRISE_REGISTRATION_RULE =
  "A general partnership formed in Quebec must be registered whatever its name; a sole proprietor must register " +
  "only when trading under a name that does not include their own surname and given name (Act respecting the " +
  "legal publicity of enterprises, s.21).";
