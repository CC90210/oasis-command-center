import Link from "next/link";
import { redirect } from "next/navigation";
import { Card, EmptyState, PageHeader, Tag } from "@/components/Card";
import { resolveSessionContext } from "@/lib/api-auth";
import { getServiceSupabase } from "@/lib/supabase-server";
import { WEBSITE_SALES_STAGES } from "@/lib/website-sales";

export const dynamic = "force-dynamic";
type LeadRow = { id:string; data:Record<string,unknown>; updated_at:string };
type DealRow = { id:string;lead_id:string;package_id:string;setup_amount:number;monthly_amount:number;proposal_status:string;status:string;updated_at:string };
type OnboardingRow = { id:string;lead_id:string;status:string;target_launch_date:string|null;updated_at:string };
type CommissionRow = { id:string;rep_user_id:string;collected_setup_amount:number;rate:number;amount:number;status:string;created_at:string };

export default async function SalesEnginePage() {
  const session = await resolveSessionContext();
  if (!session.ok) redirect("/login");
  const db = getServiceSupabase();
  let leadQuery = db.from("tenant_records").select("id,data,updated_at").eq("tenant_id", session.tenantId).eq("entity_type","lead").order("updated_at",{ascending:false}).limit(500);
  if (!session.isAdmin) leadQuery = leadQuery.contains("data",{assigned_to:session.userId});
  let commissionQuery = db.from("website_sales_commissions").select("id,rep_user_id,collected_setup_amount,rate,amount,status,created_at").eq("tenant_id", session.tenantId).order("created_at",{ascending:false});
  if (!session.isAdmin) commissionQuery = commissionQuery.eq("rep_user_id",session.userId);
  const [leadsResult,dealsResult,onboardingResult,commissionsResult] = await Promise.all([
    leadQuery,
    db.from("website_deals").select("id,lead_id,package_id,setup_amount,monthly_amount,proposal_status,status,updated_at").eq("tenant_id", session.tenantId).order("updated_at",{ascending:false}),
    db.from("website_onboarding").select("id,lead_id,status,target_launch_date,updated_at").eq("tenant_id", session.tenantId).order("updated_at",{ascending:false}),
    commissionQuery,
  ]);
  const leads=(leadsResult.data||[]) as LeadRow[]; const deals=(dealsResult.data||[]) as DealRow[]; const onboarding=(onboardingResult.data||[]) as OnboardingRow[]; const commissions=(commissionsResult.data||[]) as CommissionRow[];
  const warnings=[dealsResult.error,onboardingResult.error,commissionsResult.error].filter(Boolean).map(e=>e!.message);
  const repQueue=leads.filter(l=>["researched","assigned","attempting_contact","connected","qualified"].includes(String(l.data.stage||"researched")));
  const founderQueue=leads.filter(l=>String(l.data.stage)==="founder_meeting_booked");
  const proposals=deals.filter(d=>d.status==="open" || d.proposal_status==="sent");
  const leadName=(id:string)=>{const lead=leads.find(l=>l.id===id);return String(lead?.data.company||lead?.data.name||"Lead");};
  return <div className="space-y-6 animate-fade-in">
    <PageHeader title="Website Sales Engine" subtitle="From researched lead to launched website, with frozen rep attribution and founder-controlled pricing." action={<Tag tone="accent">{leads.length} leads</Tag>}/>
    {warnings.length>0 && <Card title="Schema setup required"><p className="text-sm text-status-warm">The sales engine migration has not been applied to this environment. Existing leads still render; financial and fulfillment boards stay empty until migration 151 is approved and applied.</p></Card>}
    <div className="grid grid-cols-2 md:grid-cols-5 gap-3"><Metric label="Rep queue" value={repQueue.length}/><Metric label="Founder meetings" value={founderQueue.length}/><Metric label="Open proposals" value={proposals.length}/><Metric label="In fulfillment" value={onboarding.length}/><Metric label="Commission entries" value={commissions.length}/></div>
    <Board title="Rep Queue" subtitle="Assigned work, next calls, audit evidence, and qualification." empty="No assigned leads need a rep action.">{repQueue.map(l=><LeadCard key={l.id} lead={l}/>)}</Board>
    <Board title="Founder Handoffs" subtitle="Qualified meetings with the promised demo frozen into the handoff." empty="No founder meetings are booked.">{founderQueue.map(l=><LeadCard key={l.id} lead={l}/>)}</Board>
    <Board title="Proposal & Close" subtitle="Only CC or Adon can set final scope, price, payment, and outcome." empty="No proposals are awaiting a close.">{proposals.map(d=><Row key={d.id} title={leadName(d.lead_id)} meta={`${d.package_id} · $${Number(d.setup_amount).toLocaleString()} setup · $${Number(d.monthly_amount)}/mo`} tag={d.proposal_status}/>)}</Board>
    <Board title="Fulfillment" subtitle="Asset intake, build, client review, and launch." empty="No won deals are in fulfillment.">{onboarding.map(o=><Row key={o.id} title={leadName(o.lead_id)} meta={o.target_launch_date?`Target ${o.target_launch_date}`:"Launch date not set"} tag={o.status}/>)}</Board>
    <Board title="Commission Ledger" subtitle="Collected setup revenue only. Refunds remain visible as offsets." empty="No commission has accrued.">{commissions.map(c=><Row key={c.id} title={`$${Number(c.amount).toLocaleString()} commission`} meta={`${Number(c.rate)*100}% of $${Number(c.collected_setup_amount).toLocaleString()} · rep ${c.rep_user_id.slice(0,8)}`} tag={c.status}/>)}</Board>
    <Card title="Lifecycle"><div className="flex flex-wrap gap-2">{WEBSITE_SALES_STAGES.map((stage,i)=><span key={stage} className="text-xs rounded-full border border-bg-border bg-bg-elev px-2.5 py-1 text-fg-muted">{i+1}. {stage.replaceAll("_"," ")}</span>)}</div></Card>
  </div>;
}

function Metric({label,value}:{label:string;value:number}) { return <div className="rounded-lg border border-bg-border bg-bg-panel p-3"><div className="text-2xl font-bold text-fg">{value}</div><div className="text-xs text-fg-muted">{label}</div></div>; }
function Board({title,subtitle,empty,children}:{title:string;subtitle:string;empty:string;children:React.ReactNode}) { const items=Array.isArray(children)?children:[children]; return <Card title={title} subtitle={subtitle}>{items.length===0?<EmptyState message={empty}/>:<div className="grid md:grid-cols-2 xl:grid-cols-3 gap-3">{children}</div>}</Card>; }
function LeadCard({lead}:{lead:LeadRow}) { const d=lead.data; return <Link href={`/pipeline/${lead.id}`} className="rounded-lg border border-bg-border bg-bg-elev/40 p-3 hover:border-accent/50"><div className="font-bold text-sm text-fg">{String(d.company||d.name||"Unnamed lead")}</div><div className="text-xs text-fg-muted mt-1">{String(d.website_condition||d.audit_findings||"Website audit needed")}</div><div className="flex justify-between mt-3 text-[10px] uppercase tracking-wider"><span className="text-accent">{String(d.stage||"researched").replaceAll("_"," ")}</span><span className="text-fg-dim">{String(d.icp_track||"unclassified")}</span></div></Link>; }
function Row({title,meta,tag}:{title:string;meta:string;tag:string}) { return <div className="rounded-lg border border-bg-border bg-bg-elev/40 p-3"><div className="flex justify-between gap-3"><div className="font-bold text-sm text-fg">{title}</div><Tag tone="neutral">{tag.replaceAll("_"," ")}</Tag></div><div className="text-xs text-fg-muted mt-2">{meta}</div></div>; }
