/**
 * A form link with more segments than a lead link has: the public not-found
 * (app/f/not-found.tsx), not the signed-in app's.
 */
import { notFound } from "next/navigation";

export default function DeepFormLinkNotFound(): never {
  notFound();
}
