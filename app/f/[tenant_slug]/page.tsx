/**
 * /f/<workspace> with no form is not a form: the public not-found
 * (app/f/not-found.tsx), not the signed-in app's. A catch-all cannot sit here
 * beside [tenant_slug] (Next refuses two slug names at one level), so each
 * shape the form routes do not match has a page of its own.
 */
import { notFound } from "next/navigation";

export default function WorkspaceFormsNotFound(): never {
  notFound();
}
