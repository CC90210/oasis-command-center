/**
 * /f on its own is not a form: the public not-found (app/f/not-found.tsx), not
 * the signed-in app's. See tests/public-form-not-found.test.ts.
 */
import { notFound } from "next/navigation";

export default function FormsRootNotFound(): never {
  notFound();
}
