/**
 * /growth has no page of its own: the Growth mode's first row is Pipeline
 * (lib/os/nav.ts, the mode tab's `home`). A trimmed URL lands there instead of
 * on a 404. Pipeline carries its own gate.
 */
import { redirect } from "next/navigation";

export default function GrowthIndex(): never {
  redirect("/pipeline");
}
