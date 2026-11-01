import { redirect } from "next/navigation";
import { requireOsRoute } from "@/components/os/landings/page-gate";

/** Preserve the handover's old bookmark; the canonical route owns the gate. */
export default async function MarketingAdsRedirect() {
  await requireOsRoute("/growth/ads");
  redirect("/growth/ads");
}
