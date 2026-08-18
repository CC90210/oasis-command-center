import { redirect } from "next/navigation";

export const metadata = {
  title: "Arthrisil · Marketing · OASIS",
};

export default function ArthrisilMarketingPage() {
  redirect("/founders/marketing/library?group=clients&brand=arthrisil");
}
