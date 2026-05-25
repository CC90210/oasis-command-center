import { ComingSoon } from "@/components/sunbiz/ComingSoon";
import { Code2 } from "lucide-react";

export const dynamic = "force-dynamic";

export default function EmbedPage() {
  return (
    <ComingSoon
      title="Embed"
      subtitle="Embeddable lead-capture widgets for your website"
      icon={Code2}
      phase2Bullets={[
        "Generate a script snippet you can paste on your site.",
        "New website leads land in the same pipeline as every other lead.",
        "Customize colors, fields, and qualification questions per form.",
        "See which pages on your site convert best.",
      ]}
      related={[{ href: "/leads", label: "Leads" }, { href: "/import", label: "Import" }]}
    />
  );
}
