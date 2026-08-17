import Image from "next/image";
import { Card, PageHeader } from "@/components/Card";

export const metadata = {
  title: "Arthrisil Marketing | OASIS Command Center",
};

export default function ArthrisilMarketingPage() {
  return (
    <div className="space-y-6 animate-fade-in">
      <PageHeader
        title="Arthrisil Marketing"
        subtitle="Doctor footage, campaign edits, and brand-approved creative reviews."
      />

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.35fr)_minmax(320px,.65fr)]">
        <Card title="Doctor source video" subtitle="Internal review footage · Dr. Michael Azoulay, DC · 4:07">
          <div className="overflow-hidden rounded-2xl border border-bg-border bg-black">
            <video
              className="mx-auto block max-h-[72vh] w-full bg-black object-contain"
              controls
              playsInline
              preload="metadata"
              poster="/media/arthrisil-marketing/end-card-preview.png"
            >
              <source src="/media/arthrisil-marketing/doctor-source.mp4" type="video/mp4" />
              Your browser does not support HTML video.
            </video>
          </div>
          <p className="mt-4 text-sm leading-6 text-fg-muted">
            This is the supplied source recording, not the finished social-proof cut. The public edit remains gated for clip rights, practitioner-title verification, and licensed-claim review.
          </p>
        </Card>

        <Card title="End-card direction" subtitle="1080 × 1920 · five-second closing frame">
          <div className="overflow-hidden rounded-2xl border border-bg-border bg-bg-elev">
            <Image
              src="/media/arthrisil-marketing/end-card-preview.png"
              alt="Arthrisil branded video end card with bottle and arthrisil.com link"
              width={1080}
              height={1920}
              className="h-auto w-full"
              priority
            />
          </div>
          <div className="mt-4 rounded-xl border border-bg-border bg-bg-elev p-4">
            <p className="text-xs font-bold uppercase tracking-[0.16em] text-accent">Creative status</p>
            <p className="mt-2 text-sm font-semibold text-fg">Concept ready for internal approval</p>
            <p className="mt-1 text-sm leading-6 text-fg-muted">
              Uses the licensed osteoarthritis claim, NPN 80065384, canonical website, and mandatory shellfish disclosure.
            </p>
          </div>
        </Card>
      </div>
    </div>
  );
}
