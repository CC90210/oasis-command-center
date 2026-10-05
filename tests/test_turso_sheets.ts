import { getServiceSupabase } from "../lib/supabase-server";
import { WEBDEV_TENANT_ID } from "../lib/web-leads/tenant";

async function main() {
  const db = getServiceSupabase();
  const { data, error } = await db
    .from("leadgen_territories")
    .select("id,region,locality,vertical,leads_total,leads_callable,leads_no_site,leads_callable_no_site,tenant_id")
    .eq("tenant_id", WEBDEV_TENANT_ID);

  if (error) {
    console.error("Error fetching sheets:", error);
    return;
  }

  const verts = Array.from(new Set((data || []).map((r: any) => r.vertical)));
  console.log("Unique verticals count:", verts.length);
  console.log("Verticals list:", verts);

  const cc = (data || []).filter((r: any) => String(r.vertical).toLowerCase().includes("cc"));
  console.log("Matching CC sheets:", cc.length);
  for (const s of cc) {
    console.log(" ", s);
  }
}

main().catch(console.error);
