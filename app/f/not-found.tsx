/**
 * Public form links (/f/...) that have nothing to show. Without this, notFound()
 * under /f fell through to app/not-found.tsx, the signed-in app's page.
 * See components/forms/PublicFormNotFound.tsx.
 */
import type { Metadata } from "next";
import { PublicFormNotFound } from "@/components/forms/PublicFormNotFound";

export const metadata: Metadata = {
  title: "Page not available",
  robots: { index: false, follow: false },
};

export default function PublicFormNotFoundPage() {
  return <PublicFormNotFound />;
}
