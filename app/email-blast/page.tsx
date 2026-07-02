import { ConstantContactBlast } from "@/components/campaigns/ConstantContactBlast";

export const dynamic = "force-dynamic";

export default function EmailBlastPage() {
  return (
    <div className="p-4 md:p-6 max-w-3xl">
      <ConstantContactBlast />
    </div>
  );
}
