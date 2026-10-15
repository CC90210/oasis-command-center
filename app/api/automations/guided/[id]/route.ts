/**
 * PATCH  /api/automations/guided/[id]   change a saved automation. Changing a turned-on one switches it
 *                                       off: it must be tested and turned on again.
 * DELETE /api/automations/guided/[id]   delete it. Its past runs and receipts stay.
 *
 * Only the automation's owner may do either (lib/automations/guided-service.ts).
 */
import { guidedRoute } from "@/lib/automations/guided-http";
import { removeAutomation, updateAutomation } from "@/lib/automations/guided-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  return guidedRoute(req, { write: true, id, body: true }, (s, body) => updateAutomation(s, id, { name: body.name, payload: body.payload }));
}

export async function DELETE(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  return guidedRoute(req, { write: true, id }, (s) => removeAutomation(s, id));
}
