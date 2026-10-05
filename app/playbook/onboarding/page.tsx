import { redirect } from "next/navigation";
import { requirePlaybookReader } from "@/lib/playbook-access";

export const dynamic = "force-dynamic";

/**
 * /playbook/onboarding - retired. It read four SOPs from
 * process.cwd()/../../docs/playbooks, a path outside the app that exists on no
 * platform, so it rendered four "file is missing" cards, and nothing linked to
 * it. Those four files were the SunBiz "Meet Solara" client guides, retired
 * with SunBiz (2026-09-28). The operator SOPs live in the Playbook's
 * Operating manual section, bundled into the Worker (lib/playbooks.ts).
 *
 * The guard runs first, so a visitor from another workspace still gets the
 * 404 every /playbook page gives them, never a redirect that confirms the
 * route exists.
 */
export default async function PlaybookOnboardingPage() {
  await requirePlaybookReader();
  redirect("/playbook#operating-manual");
}
