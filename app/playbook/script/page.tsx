/**
 * /playbook/script — the rep call guide. The guide itself is interactive, so it
 * lives in ScriptClient; this server page runs the /playbook access guard first
 * (lib/playbook-access.ts), which a client component cannot do.
 */
import { requirePlaybookReader } from "@/lib/playbook-access";
import { ScriptClient } from "./ScriptClient";

export default async function ScriptPage() {
  await requirePlaybookReader();
  return <ScriptClient />;
}
