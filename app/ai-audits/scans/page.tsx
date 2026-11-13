/**
 * /ai-audits/scans — moved. The free scan is one of the Offers (CC, 2026-11-13: tracked with the
 * other offers, not on the AI audits board); its details live at /forms/scans.
 */
import { permanentRedirect } from "next/navigation";
import { SCAN_DETAILS_PATH } from "@/lib/site-scan/offer";

export default function MovedFreeScansPage(): never {
  permanentRedirect(SCAN_DETAILS_PATH);
}
