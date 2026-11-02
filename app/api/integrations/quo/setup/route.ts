import { handleQuoSetup } from "@/lib/integrations/quo-setup-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: Request) { return handleQuoSetup(req); }
export async function POST(req: Request) { return handleQuoSetup(req); }
