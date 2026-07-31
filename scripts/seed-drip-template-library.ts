import { createClient } from "@supabase/supabase-js";

type Seed = { name: string; stage: string; style: string; subject: string; body: string };

const LINK = "{{lead.application_url}}";
const seeds: Seed[] = [
  { name: "Follow Up - Jordan Direct", stage: "follow_up", style: "jordan_direct", subject: "Quick question for {{lead.business_name}}", body: "Hi {{lead.first_name}},\n\nAre you still looking for working capital?\n\nIf yes, reply with the amount you need and what you want to use it for. I will have my team review the file and tell you what makes sense.\n\n{{lead.rep_name}}" },
  { name: "Follow Up - Advisor Check-In", stage: "follow_up", style: "warm_advisor", subject: "Still looking at funding options?", body: "Hi {{lead.first_name}},\n\nChecking in on {{lead.business_name}}. If funding is still on the table, send me the amount you need and a quick note on the use of funds.\n\nWe will review the business first and only present an option that fits the file.\n\n{{lead.rep_name}}" },
  { name: "Viewed Application - Finish It", stage: "viewed_application", style: "jordan_direct", subject: "Your application is still open", body: `Hi {{lead.first_name}},\n\nYou opened the application but it has not been completed yet.\n\nDo you have 2 minutes to finish it right now?\n\n${LINK}\n\nOnce received, we can begin underwriting.\n\nThanks!` },
  { name: "Viewed Application - Need Help?", stage: "viewed_application", style: "warm_advisor", subject: "Anything unclear on the application?", body: `Hi {{lead.first_name}},\n\nI saw that you opened the application for {{lead.business_name}}.\n\nIf anything is unclear, reply here and I will help. You can continue from the same link:\n\n${LINK}\n\nOnce it is complete, my team can review the file.` },
  { name: "Sent Application - Direct Link", stage: "sent_application", style: "jordan_direct", subject: "Application Form", body: `Hi,\n\nPlease fill out our application form:\n\n${LINK}\n\nOnce received, we can begin underwriting and present an offer.\n\nThanks!` },
  { name: "Sent Application - Secure Resume", stage: "sent_application", style: "warm_advisor", subject: "Your SunBiz application link", body: `Hi {{lead.first_name}},\n\nHere is the secure application link for {{lead.business_name}}:\n\n${LINK}\n\nIt is tied to your record, so you can return to the same link if you need to finish later.\n\nOnce received, my team can begin underwriting.\n\n{{lead.rep_name}}` },
  { name: "Sent Application Completion - Two Minutes", stage: "sent_application", style: "concise_follow_up", subject: "Do you have 2 minutes to finish this?", body: `Hi {{lead.first_name}},\n\nYour application is still incomplete.\n\nDo you have 2 minutes to fill it out right now?\n\n${LINK}\n\nReply if anything is holding you up.` },
  { name: "Sent Application Completion - Underwriting Next", stage: "sent_application", style: "urgent_document_chase", subject: "Last step before we review {{lead.business_name}}", body: `Hi {{lead.first_name}},\n\nI can have my team review {{lead.business_name}}, but I need the completed application first.\n\nFinish it here:\n\n${LINK}\n\nOnce it is in, we can review the financials and determine what the file qualifies for.` },
  { name: "Missing Info - What We Need", stage: "missing_info", style: "jordan_direct", subject: "A few items are still missing", body: `Hi {{lead.first_name}},\n\nWe are missing information needed to review {{lead.business_name}}.\n\nPlease return to your application and complete the open items:\n\n${LINK}\n\nReply when it is done and I will have my team check it.` },
  { name: "Missing Info - Quick Help", stage: "missing_info", style: "warm_advisor", subject: "Can I help finish your file?", body: `Hi {{lead.first_name}},\n\nYour file is close, but a few items are still missing.\n\nYou can update them here:\n\n${LINK}\n\nIf you are unsure what we need, reply and I will tell you exactly what is outstanding.` },
  { name: "Signed Application - Bank Statements", stage: "signed_application", style: "jordan_direct", subject: "Please send the last 3 months of statements", body: `Hi {{lead.first_name}},\n\nWe received the signed application.\n\nPlease upload the last 3 months of business bank statements here:\n\n${LINK}\n\nOnce received, we can begin underwriting.\n\nThanks!` },
  { name: "Signed Application - Final Underwriting Item", stage: "signed_application", style: "urgent_document_chase", subject: "Final item for {{lead.business_name}}", body: `Hi {{lead.first_name}},\n\nThe application is signed. The only item holding up review is the last 3 months of business bank statements.\n\nUpload them here:\n\n${LINK}\n\nPDF exports from online banking work best.` },
  { name: "Declined - Circumstances Changed", stage: "declined", style: "jordan_direct", subject: "Has anything changed with {{lead.business_name}}?", body: `Hi {{lead.first_name}},\n\nChecking back on {{lead.business_name}}.\n\nHas revenue, cash flow, or your current funding position improved since we last reviewed the file?\n\nIf yes, update the application here and I will have my team take another look:\n\n${LINK}` },
  { name: "Declined - Revisit the File", stage: "declined", style: "warm_advisor", subject: "We can revisit the file", body: `Hi {{lead.first_name}},\n\nThe last review did not produce an option that made sense. That can change when the business has stronger deposits, fewer positions, or cleaner payment history.\n\nIf the situation has improved, update the file here:\n\n${LINK}\n\nWe will review it again without overpromising an approval.` },
];

function escapeHtml(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function htmlFor(seed: Seed) {
  const body = escapeHtml(seed.body)
    .replace(/\n\n/g, "</p><p style=\"margin:0 0 16px\">")
    .replace(/\n/g, "<br>");
  return `<!doctype html><html><body style="margin:0;background:#f4f6fa;padding:24px"><div style="display:none;max-height:0;overflow:hidden">${escapeHtml(seed.subject)}</div><table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center"><table role="presentation" width="600" style="max-width:600px;width:100%;background:#fff;border:1px solid #dce3ee;border-radius:12px"><tr><td style="background:#001f54;padding:22px 28px;color:#fff;font:800 19px Arial,sans-serif;letter-spacing:1px">SUN<span style="color:#d4a843">BIZ</span> FUNDING</td></tr><tr><td style="padding:30px 28px;color:#172033;font:15px/1.65 Arial,sans-serif"><p style="margin:0 0 16px">${body}</p><div style="margin-top:24px;padding-top:16px;border-top:1px solid #e7ebf1;color:#708096;font-size:11px">Funding options are subject to underwriting review. No approval, amount, rate, or term is guaranteed.</div></td></tr></table></td></tr></table></body></html>`;
}

async function main() {
  const url = process.env.BRAVO_SUPABASE_URL;
  const key = process.env.BRAVO_SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("BRAVO_SUPABASE_URL and BRAVO_SUPABASE_SERVICE_ROLE_KEY are required");
  const db = createClient(url, key, { auth: { persistSession: false } });
  const tenantResult = await db.from("drip_sequences").select("tenant_id").eq("enabled", true).limit(1).single();
  if (tenantResult.error) throw tenantResult.error;
  const tenantId = tenantResult.data.tenant_id;
  const existingResult = await db.from("cc_email_templates").select("id,name").eq("tenant_id", tenantId).like("category", "drip:%");
  if (existingResult.error) throw existingResult.error;
  const existing = new Map((existingResult.data || []).map((row) => [row.name, row.id]));
  let inserted = 0, updated = 0;
  for (const seed of seeds) {
    const payload = { tenant_id: tenantId, name: seed.name, category: `drip:${seed.stage}:${seed.style}`, subject: seed.subject, preheader: seed.body, html: htmlFor(seed), updated_at: new Date().toISOString() };
    const id = existing.get(seed.name);
    const result = id ? await db.from("cc_email_templates").update(payload).eq("id", id).eq("tenant_id", tenantId) : await db.from("cc_email_templates").insert(payload);
    if (result.error) throw result.error;
    id ? updated++ : inserted++;
  }
  console.log(JSON.stringify({ ok: true, templates: seeds.length, inserted, updated }));
}

void main();
