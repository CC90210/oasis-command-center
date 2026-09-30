/**
 * /admin/installs - OASIS sets up client workspaces here.
 *
 * GATE: requireOperator() as the FIRST statement: a verified platform operator
 * (operator alias AND an owner/admin OASIS membership by auth id). Everyone
 * else, signed out included, gets a 404 before anything is read.
 *
 * What an operator can do (each a confirmed click, each recorded):
 *   - see every workspace: name, owner, members, whether it is set up, last
 *     activity;
 *   - create a new client workspace and set it up;
 *   - set up (or re-set up) an existing one: departments, add-ons, chat apps,
 *     the fast classifier (lib/provisioning/provision-tenant.ts);
 *   - send the founder the owner invite, the only invite that makes an owner.
 */

import { requireOperator } from "@/lib/role-surfaces-session";
import { PageFrame } from "@/components/os/PageFrame";
import { InstallsConsole, type ConsoleOptions } from "@/components/admin/installs/InstallsConsole";
import { departmentProfile } from "@/components/os/department/config";
import { MANIFEST_CHAT_APPS } from "@/lib/manifest/schema";
import { listInstalls, type InstallRow } from "@/lib/provisioning/installs";
import { DEFAULT_DEPARTMENTS, OPT_IN_MODULES, neutralTeamFor } from "@/lib/provisioning/team";
import { OS_DEPARTMENTS } from "@/lib/os/departments";

export const dynamic = "force-dynamic";
export const metadata = { title: "Client installs" };

const CHAT_APP_LABELS: Record<(typeof MANIFEST_CHAT_APPS)[number], string> = {
  slack: "Slack",
  teams: "Microsoft Teams",
  telegram: "Telegram",
  email: "Email only",
};

function consoleOptions(): ConsoleOptions {
  return {
    departments: OS_DEPARTMENTS.map((d) => ({
      key: d.key,
      label: d.label,
      purpose: departmentProfile(d.key).purpose,
      teammate: neutralTeamFor([d.key])[0]?.display_name ?? null,
      locked: d.key === "chief_of_staff",
    })),
    defaultDepartments: [...DEFAULT_DEPARTMENTS],
    modules: OPT_IN_MODULES.map((m) => ({ key: m.key, label: m.label, description: m.description })),
    chatApps: MANIFEST_CHAT_APPS.map((key) => ({ key, label: CHAT_APP_LABELS[key] })),
  };
}

export default async function InstallsPage() {
  await requireOperator();
  let installs: InstallRow[] | null = null;
  try {
    installs = await listInstalls();
  } catch (err) {
    console.error("[admin.installs.page]", err);
  }
  return (
    <PageFrame
      title="Client installs"
      subtitle="Create a client workspace, set it up, and send its founder the owner invite. Operators only."
    >
      {installs === null ? (
        <section className="max-w-2xl rounded-xl border border-hairline bg-bg-panel p-4 text-sm text-fg">
          Could not read the workspace list. Nothing is shown rather than a partial list. Reload the page to try again.
        </section>
      ) : (
        <InstallsConsole installs={installs} options={consoleOptions()} />
      )}
    </PageFrame>
  );
}
