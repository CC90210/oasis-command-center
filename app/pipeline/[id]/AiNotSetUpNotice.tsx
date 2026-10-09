/**
 * What ScoreLeadButton and NextActionButton say when the AI call answers
 * `ai_unavailable`.
 *
 * Both used to print an environment variable name and tell the reader to set
 * it "on the dashboard's Vercel env": a name no client should see, on a host
 * this app has left, as an instruction only an operator could follow. Now an
 * owner gets a link to where the workspace's AI account is connected, and
 * everyone else is told who can fix it.
 *
 * No hooks, so tests render it under react-server.
 */
import { setupHref } from "@/lib/setup-links";

/** Settings > AI brain > AI setup, where the key is saved (lib/setup-links.ts). */
export const AI_SETTINGS_HREF = setupHref("ai_account");

export function AiNotSetUpNotice({ feature, canConfigureAi }: { feature: string; canConfigureAi: boolean }) {
  return (
    <>
      <span className="font-bold">{feature} isn&apos;t set up for this workspace. </span>
      {canConfigureAi ? (
        <>
          Connect an AI account in{" "}
          <a href={AI_SETTINGS_HREF} className="underline underline-offset-2">
            Settings &gt; AI brain
          </a>
          .
        </>
      ) : (
        <>Ask your workspace owner to connect an AI account.</>
      )}
    </>
  );
}
