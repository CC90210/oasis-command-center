import { ComingSoon } from "@/components/sunbiz/ComingSoon";
import { Mail } from "lucide-react";

export const dynamic = "force-dynamic";

export default function EmailBlastPage() {
  return (
    <ComingSoon
      title="Email Blast"
      subtitle="Bulk email campaigns with approved templates"
      icon={Mail}
      phase2Bullets={[
        "Pick a template, choose a recipient list, and preview each message before sending.",
        "Sends are paced automatically so your mailbox reputation stays healthy.",
        "Track delivery, opens, replies, and unsubscribes per recipient.",
        "Use the approved email templates configured for your workspace.",
      ]}
      related={[{ href: "/templates", label: "Templates" }, { href: "/sms", label: "SMS" }]}
    />
  );
}
