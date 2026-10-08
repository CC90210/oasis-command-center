import Link from "next/link";
import { requireOperator } from "@/lib/role-surfaces-session";
import { SERVICE_ACCOUNT_EMAIL } from "@/lib/seo/types";
import { PageFrame } from "@/components/os/PageFrame";
import { AddSiteForm } from "@/components/seo/AddSiteForm";

export const dynamic = "force-dynamic";

export default async function SeoAddPage() {
  // GATE: requireOperator() as the FIRST statement. The data is never fetched for anyone else.
  await requireOperator();
  return (
    <PageFrame
      title="Add a site"
      subtitle={
        <>
          <Link prefetch={false} href="/seo" className="text-fg-muted hover:text-fg hover:underline">All sites</Link>
          {" — Nothing is collected until Google confirms the client has shared access."}
        </>
      }
    >
      <AddSiteForm serviceAccount={SERVICE_ACCOUNT_EMAIL} />
    </PageFrame>
  );
}
