import { redirect } from "next/navigation";

export const metadata = {
  title: "Arthrisil · Content · OASIS",
};

export default function ArthrisilMarketingPage() {
  redirect("/founders/marketing/library?group=clients&brand=arthrisil");
}
