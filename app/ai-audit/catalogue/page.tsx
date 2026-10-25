/**
 * /ai-audit/catalogue — the one service catalogue proposals price from.
 * Founders see it; only the workspace owner confirms or retires a price.
 */
import Link from "next/link";
import { notFound } from "next/navigation";
import { PageFrame } from "@/components/os/PageFrame";
import { aiAuditPageSession } from "@/lib/ai-audit/access";
import { listCatalogue } from "@/lib/ai-audit/catalogue-store";
import { CatalogueManager } from "@/components/ai-audit/workspace/CatalogueManager";

export const dynamic = "force-dynamic";

export default async function CataloguePage() {
  const session = await aiAuditPageSession();
  if (!session) notFound();
  const items = await listCatalogue(session.db, session.tenantId);
  const confirmed = items.filter((i) => i.status === "confirmed").length;
  return (
    <PageFrame
      title="Price catalogue"
      subtitle={`${confirmed} confirmed price${confirmed === 1 ? "" : "s"}. A proposal can only use a confirmed price or one you type for custom work.`}
      actions={
        <Link href="/ai-audit" className="btn-secondary">
          Back to AI audits
        </Link>
      }
    >
      <CatalogueManager items={JSON.parse(JSON.stringify(items))} isOwner={session.isOwner} />
    </PageFrame>
  );
}
