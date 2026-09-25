import { NextRequest, NextResponse } from "next/server";
import { startProvisioningRun, updateProvisioningRun } from "@/lib/client-provisioning";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();

    // Basic structural check for a Stripe event
    if (!body || !body.type || !body.data || !body.data.object) {
      return NextResponse.json({ error: "Invalid Stripe event" }, { status: 400 });
    }

    const eventType = body.type;
    const obj = body.data.object;

    if (eventType === "checkout.session.completed") {
      const tenantId = obj.client_reference_id || (obj.metadata && obj.metadata.tenant_id);
      
      if (tenantId) {
        // Log the run creation
        await startProvisioningRun(tenantId, obj.invoice || obj.id);
        
        // Simulate immediate step progression (since actual provisioning 
        // involves async n8n/Pulumi triggers which will be built out later)
        await updateProvisioningRun(tenantId, "provisioning", "Payment confirmed");
        
        // Next steps could be triggered via background queues or n8n webhooks
      }
    }

    // Return a 200 to acknowledge receipt of the event
    return NextResponse.json({ received: true });
  } catch (err) {
    console.error("Stripe webhook error:", err);
    return NextResponse.json(
      { error: "Webhook handler failed" },
      { status: 500 }
    );
  }
}
