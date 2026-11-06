/** Temporary read-only diagnostic: schema and aggregate delivery metadata only. */
import { createClient } from "@libsql/client";
import { spawnSync } from "node:child_process";

const db = createClient({ url: process.env.TURSO_DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN });
const tenant = "ef8d389e-3f15-43f2-ae00-3660f69a1452";
function safeCode(value: unknown): string {
  if (value === null || value === undefined || value === "") return "none";
  const raw = String(value);
  if (/^[a-z][a-z0-9_]{0,70}$/.test(raw) && raw.includes("_")) return raw;
  const prefix = /^(?:gmail|quo|telegram|outbox|sms|email|send_gateway|auth|smtp)_[a-z0-9_]{1,60}(?=[:\s]|$)/.exec(raw);
  if (prefix) return prefix[0];
  for (const [label, pattern] of [
    ["authentication", /auth|credential|unauthori[sz]ed|invalid.grant|invalid.token/i],
    ["rate_limit", /rate.limit|quota|too.many|429/i],
    ["network_timeout", /timeout|timed.out|econn|network|fetch.failed/i],
    ["runtime_unavailable", /offline|bridge|computer|runtime|cli/i],
    ["recipient_rejected", /recipient|address|mailbox|bounce|550/i],
    ["send_gateway", /gateway|send.failed|delivery.failed/i],
  ] as const) if (pattern.test(raw)) return label;
  return "other_redacted_error";
}
function errorFacts(value: unknown): string[] {
  const raw = String(value ?? "");
  return [
    ["gmail", /gmail/i], ["telegram", /telegram/i], ["twilio", /twilio/i],
    ["texttorrent", /texttorrent/i], ["quo", /\bquo\b/i], ["smtp", /smtp/i],
    ["not_connected", /not.connected|no.gmail_oauth.bundle/i], ["invalid_grant", /invalid_grant/i],
    ["http_401", /\b401\b/i], ["http_403", /\b403\b/i], ["http_429", /\b429\b/i],
    ["disabled", /disabled|switched.off/i], ["missing_configuration", /not.configured|missing|no.token/i],
    ["blocked", /blocked|refused/i], ["opt_out_or_consent", /consent|suppression|opt.out/i],
  ].filter(([,pattern]) => (pattern as RegExp).test(raw)).map(([label]) => String(label));
}
async function main() {
  if (process.argv.includes("--automation-outcomes")) {
    const day=new Date(Date.now()-86400000).toISOString();
    const week=new Date(Date.now()-7*86400000).toISOString();
    const audit: Array<[string,string,string[]]> = [
      ["switches","SELECT route,enabled,changed_at FROM cron_job_switches ORDER BY route",[]],
      ["cron_transport_24h","SELECT route,http_status,COUNT(*) AS ticks,SUM(ok) AS ok_ticks,MAX(tick_at) AS latest_at FROM cron_runs WHERE tick_at>=? GROUP BY route,http_status ORDER BY route",[day]],
      ["maven_intents","SELECT state,error AS error_code,COUNT(*) AS count,MAX(created_at) AS latest_created,MAX(finished_at) AS latest_finished FROM marketing_publish_intent WHERE tenant_id=? GROUP BY state,error",[tenant]],
      ["template_population","SELECT enabled,COUNT(*) AS count FROM plan_templates WHERE tenant_id=? GROUP BY enabled",[tenant]],
      ["daily_plan_receipts","SELECT COUNT(*) AS count,MAX(plan_date) AS latest_plan_date,MAX(created_at) AS latest_created FROM daily_plans WHERE tenant_id=?",[tenant]],
      ["nurture_sequences","SELECT enabled,COUNT(*) AS count FROM drip_sequences WHERE tenant_id=? GROUP BY enabled",[tenant]],
      ["sms_agent_receipts","SELECT provider,status,last_error AS error_code,COUNT(*) AS count,MAX(received_at) AS latest_received,MAX(completed_at) AS latest_completed FROM sms_agent_jobs WHERE tenant_id=? AND received_at>=? GROUP BY provider,status,last_error",[tenant,week]],
      ["automation_schedules","SELECT action_type,enabled,last_run_status,COUNT(*) AS count,MAX(last_run_at) AS latest_at FROM tenant_cron_jobs WHERE tenant_id=? GROUP BY action_type,enabled,last_run_status",[tenant]],
      ["health_latest","SELECT h.check_id,h.verdict,h.ran_at FROM health_check_runs h WHERE h.tenant_id IN (?,?) AND h.ran_at=(SELECT MAX(i.ran_at) FROM health_check_runs i WHERE i.tenant_id=h.tenant_id AND i.check_id=h.check_id) ORDER BY h.check_id LIMIT 80",[tenant,'42423fde-be8b-454f-932a-750e8c9b743d']],
      ["health_delivery_failures_7d","SELECT verdict,COUNT(*) AS count,MAX(ran_at) AS latest_at FROM health_check_runs WHERE tenant_id IN (?,?) AND check_id='alerting.telegram_delivery' AND ran_at>=? GROUP BY verdict",[tenant,'42423fde-be8b-454f-932a-750e8c9b743d',week]],
      ["health_failed_lanes_7d","SELECT CASE WHEN reason LIKE '%to operator, sunbiz-ops%' THEN 'operator_and_retired' WHEN reason LIKE '%to sunbiz-ops%' THEN 'retired_sunbiz_only' WHEN reason LIKE '%to operator%' THEN 'operator_only' ELSE 'other' END AS failed_lanes,CASE WHEN reason LIKE '%another lane took it%' THEN 'another_lane_accepted' ELSE 'no_acceptance_recorded' END AS acceptance,COUNT(*) AS count,MAX(ran_at) AS latest_at FROM health_check_runs WHERE tenant_id IN (?,?) AND check_id='alerting.telegram_delivery' AND ran_at>=? GROUP BY failed_lanes,acceptance",[tenant,'42423fde-be8b-454f-932a-750e8c9b743d',week]],
    ];
    for(const [name,sql,args] of audit) {
      if(process.argv.includes("--health-lanes") && name!=="health_failed_lanes_7d") continue;
      try { const result=await db.execute({sql,args}); console.log(JSON.stringify({section:name,rows:result.rows.map(r=>Object.fromEntries(Object.entries(r).map(([k,v])=>[k,k==='error_code'?safeCode(v):v])))})); }
      catch {console.log(JSON.stringify({section:name,error:'query_failed'}));}
    }
    return;
  }
  if (process.argv.includes("--automation-schema")) {
    for (const table of ["cron_job_switches","cron_runs","tenant_cron_jobs","department_automation_runs","marketing_publish_intent","health_check_runs","health_alert_state","plan_templates","daily_plans","sms_agent_jobs","drip_sequences","call_appointments","connection_health_checks"]) {
      const result=await db.execute(`PRAGMA table_info(${table})`);
      console.log(JSON.stringify({table,columns:result.rows.map(r=>r.name)}));
    }
    return;
  }
  if (process.argv.includes("--phone-country")) {
    const rows = await db.execute({ sql: "SELECT recipient FROM website_sales_meeting_notifications WHERE tenant_id=? AND channel='sms' AND last_error='sms_timezone_unresolved'", args:[tenant] });
    // Private values stay in a local stdin pipe. Only country/NPA aggregate labels leave the parser.
    const parsed = spawnSync("python", ["-c", `import json,sys,phonenumbers,collections
out=collections.Counter()
for value in json.load(sys.stdin):
 try:
  p=phonenumbers.parse(value,None)
  label=(str(p.country_code),phonenumbers.region_code_for_number(p) or 'unknown',str(p.national_number)[:3] if p.country_code==1 else '',phonenumbers.is_valid_number(p))
 except Exception:
  label=('unknown','invalid','',False)
 out[label]+=1
print(json.dumps([dict(country_code=k[0],country=k[1],npa=k[2],valid_format=k[3],count=v) for k,v in out.items()]))`], { input:JSON.stringify(rows.rows.map(r=>String(r.recipient))), encoding:"utf8" });
    if (parsed.status!==0) throw new Error("country_parser_failed");
    console.log(JSON.stringify({section:"country_npa_counts",rows:JSON.parse(parsed.stdout)}));
    return;
  }
  const since = new Date(Date.now() - 7 * 86400000).toISOString();
  const queries: Array<[string, string, unknown[]]> = [
    ["quo_presence", `SELECT field_key,COUNT(*) AS stored_rows,MAX(CASE WHEN encrypted_value IS NOT NULL AND encrypted_value<>'' THEN 1 ELSE 0 END) AS has_value FROM tenant_integration_credentials WHERE tenant_id=? AND service='quo' GROUP BY field_key`, [tenant]],
    ["timezone_prefixes", `SELECT CASE WHEN recipient LIKE '+1%' AND length(recipient)=12 THEN 'NANP' WHEN recipient LIKE '+44%' THEN 'UK' WHEN recipient LIKE '+61%' THEN 'Australia' ELSE 'other_or_invalid' END AS country_group,CASE WHEN recipient LIKE '+1%' AND length(recipient)=12 THEN substr(recipient,3,3) END AS npa,COUNT(*) AS count FROM website_sales_meeting_notifications WHERE tenant_id=? AND channel='sms' AND last_error='sms_timezone_unresolved' GROUP BY country_group,npa`, [tenant]],
    ["telegram_receipts_7d", `SELECT status,last_error AS error_code,
      CASE WHEN json_valid(payload) THEN json_extract(payload,'$.phase') END AS phase,
      COUNT(*) AS count,MAX(retry_count) AS max_attempts,MAX(published_at) AS latest_at
      FROM agent_events WHERE correlation_id=? AND event_type='oasis_telegram_message' AND published_at>=?
      GROUP BY status,last_error,phase ORDER BY latest_at DESC LIMIT 20`, [tenant,since]],
    ["connection_health", `SELECT c.provider,c.verdict,c.error_code,c.checked_at FROM connection_health_checks c
      WHERE c.tenant_id=? AND c.checked_at=(SELECT MAX(h.checked_at) FROM connection_health_checks h WHERE h.tenant_id=c.tenant_id AND h.connection_id=c.connection_id)
      ORDER BY c.checked_at DESC LIMIT 30`, [tenant]],
    ["failed_sms_details", `SELECT id,channel,provider,created_at,
      json_extract(metadata,'$.last_attempt_at') AS last_attempt_at,json_extract(metadata,'$.attempts') AS attempts,
      json_extract(metadata,'$.send_error') AS error_code FROM lead_interactions
      WHERE tenant_id=? AND type='sms_queued' AND json_valid(metadata) AND json_extract(metadata,'$.status')='failed' LIMIT 20`, [tenant]],
    ["alert_failures", `SELECT json_extract(metadata,'$.reason') AS error_code,COUNT(*) AS count,
      MIN(created_at) AS oldest_at,MAX(created_at) AS latest_at FROM lead_interactions
      WHERE tenant_id=? AND type='alert_failed' AND json_valid(metadata) GROUP BY error_code LIMIT 20`, [tenant]],
    ["failure_metadata_keys", `SELECT i.type,i.channel,j.key,COUNT(*) AS count FROM lead_interactions i,
      json_each(CASE WHEN json_valid(i.metadata) THEN i.metadata ELSE '{}' END) j
      WHERE i.tenant_id=? AND (i.type='alert_failed' OR json_extract(CASE WHEN json_valid(i.metadata) THEN i.metadata ELSE '{}' END,'$.status')='failed')
      GROUP BY i.type,i.channel,j.key ORDER BY i.type,j.key LIMIT 80`, [tenant]],
    ["meeting_notifications", `SELECT channel,status,provider,last_error AS error_code,COUNT(*) AS count,
      MIN(due_at) AS oldest_due,MAX(updated_at) AS latest_at,
      SUM(CASE WHEN provider_receipt IS NOT NULL AND provider_receipt<>'' THEN 1 ELSE 0 END) AS with_receipt
      FROM website_sales_meeting_notifications WHERE tenant_id=?
      GROUP BY channel,status,provider,last_error ORDER BY latest_at DESC LIMIT 30`, [tenant]],
    ["failed_chat_target", `SELECT r.id,r.status,r.error_code,r.runtime_engine_name AS provider,p.label AS computer,
      r.created_at,r.finished_at FROM dept_chat_runs r LEFT JOIN bridge_pairings p ON p.id=r.target_pairing_id AND p.tenant_id=r.tenant_id
      WHERE r.tenant_id=? AND r.created_at>=? ORDER BY r.created_at DESC LIMIT 10`, [tenant,since]],
    ["more_delivery_tables", `SELECT name FROM sqlite_master WHERE type='table' AND
      (name LIKE '%telegram%' OR name LIKE '%automation%' OR name LIKE '%health%' OR name LIKE '%sms%') ORDER BY name`, []],
    ["outbound_7d", `SELECT channel,provider,type,agent_source,
      CASE WHEN json_valid(metadata) THEN json_extract(metadata,'$.status') END AS status,
      COUNT(*) AS count,MAX(created_at) AS latest_at,
      SUM(CASE WHEN provider_message_id IS NOT NULL AND provider_message_id<>'' THEN 1 ELSE 0 END) AS with_receipt
      FROM lead_interactions WHERE tenant_id=? AND direction='outbound' AND created_at>=?
      GROUP BY channel,provider,type,agent_source,status ORDER BY latest_at DESC LIMIT 40`, [tenant,since]],
    ["outbox_backlog", `SELECT channel,provider,agent_source,json_extract(metadata,'$.status') AS status,
      COUNT(*) AS count,MIN(created_at) AS oldest_at,MAX(created_at) AS latest_at,
      COALESCE(json_extract(metadata,'$.error_code'),json_extract(metadata,'$.last_error'),json_extract(metadata,'$.error')) AS error_code
      FROM lead_interactions WHERE tenant_id=? AND direction='outbound' AND json_valid(metadata)
      AND json_extract(metadata,'$.status') IN ('queued','retry','sending','failed','delivery_unknown')
      GROUP BY channel,provider,agent_source,status,error_code ORDER BY latest_at DESC LIMIT 40`, [tenant]],
    ["drip_7d", `SELECT channel,status,last_error AS error_code,COUNT(*) AS count,MIN(scheduled_for) AS oldest_due,MAX(created_at) AS latest_at,
      SUM(CASE WHEN provider_message_id IS NOT NULL AND provider_message_id<>'' THEN 1 ELSE 0 END) AS with_receipt
      FROM drip_runs WHERE tenant_id=? AND created_at>=? GROUP BY channel,status,last_error ORDER BY latest_at DESC LIMIT 30`, [tenant,since]],
    ["scheduled_messages", `SELECT channel,status,last_error AS error_code,COUNT(*) AS count,MIN(scheduled_for) AS oldest_due,MAX(created_at) AS latest_at
      FROM scheduled_sends WHERE tenant_id=? GROUP BY channel,status,last_error ORDER BY latest_at DESC LIMIT 20`, [tenant]],
    ["followup_messages_7d", `SELECT channel,status,error AS error_code,COUNT(*) AS count,MAX(updated_at) AS latest_at
      FROM followup_drip_sends WHERE tenant_id=? AND created_at>=? GROUP BY channel,status,error ORDER BY latest_at DESC LIMIT 20`, [tenant,since]],
    ["department_runs_7d", `SELECT source,origin,status,error_code,runtime_engine_name AS provider,runtime_fallback_policy AS fallback,
      COUNT(*) AS count,MAX(created_at) AS latest_at FROM dept_chat_runs WHERE tenant_id=? AND created_at>=?
      GROUP BY source,origin,status,error_code,runtime_engine_name,runtime_fallback_policy ORDER BY latest_at DESC LIMIT 35`, [tenant,since]],
    ["runtime_jobs_7d", `SELECT action,status,error_code,engine_name AS provider,COUNT(*) AS count,MAX(created_at) AS latest_at
      FROM bridge_runtime_jobs WHERE tenant_id=? AND created_at>=? GROUP BY action,status,error_code,engine_name ORDER BY latest_at DESC LIMIT 20`, [tenant,since]],
    ["agent_relay_7d", `SELECT relay_eligible,COUNT(*) AS count,
      SUM(CASE WHEN delivered_at IS NOT NULL THEN 1 ELSE 0 END) AS delivered,
      SUM(CASE WHEN acked_at IS NOT NULL THEN 1 ELSE 0 END) AS acknowledged,
      MIN(created_at) AS oldest_at,MAX(created_at) AS latest_at FROM agent_messages WHERE tenant_id=? AND created_at>=? GROUP BY relay_eligible`, [tenant,since]],
    ["chat_errors_7d", `SELECT role,COUNT(*) AS count,MAX(created_at) AS latest_at,error AS error_code
      FROM chat_messages WHERE tenant_id=? AND created_at>=? AND error IS NOT NULL AND error<>'' GROUP BY role,error ORDER BY latest_at DESC LIMIT 20`, [tenant,since]],
  ];
  console.log(JSON.stringify({ since, captured_at: new Date().toISOString(), tenant_scope: "OASIS", read_only: true }));
  for (const [name, sql, args] of queries) {
    if (process.argv.includes("--detail") && !["quo_presence", "timezone_prefixes"].includes(name)) continue;
    try {
      const result = await db.execute({ sql, args: args as string[] });
      const rows = result.rows.map(row => ({ ...Object.fromEntries(Object.entries(row).map(([key,value]) => [key,key === "error_code" ? safeCode(value) : value])),
        ...("error_code" in row ? { error_facts:errorFacts(row.error_code) } : {}) }));
      console.log(JSON.stringify({ section:name, rows }));
    } catch { console.log(JSON.stringify({ section:name,error:"query_failed" })); }
  }
}
main().catch(() => { console.error("message_diagnostic_failed"); process.exitCode = 1; }).finally(() => db.close());
