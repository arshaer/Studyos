import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib-admin";
import { db, ensureStudySchema } from "@/lib-db";
import { validateRoutingPolicy } from "@/lib-professor-routing";

export const runtime = "nodejs";

function dateValue(value: string | null, fallback: Date) {
  const parsed = value ? new Date(value) : fallback;
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : fallback.toISOString();
}

export async function GET(request: Request) {
  const adminId = await requireAdmin();
  if (!adminId) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await ensureStudySchema();
  const sql = db(), url = new URL(request.url), now = new Date();
  const from = dateValue(url.searchParams.get("from"), new Date(now.getTime() - 30 * 86_400_000));
  const to = dateValue(url.searchParams.get("to"), now);
  const [configRows, totals, periods, daily, byFeature, byProvider, byTier, byUser, sessions] = await Promise.all([
    sql`select * from public.ai_admin_config where singleton=true`,
    sql`select count(*)::int requests,coalesce(sum(input_tokens),0)::bigint input_tokens,coalesce(sum(cached_input_tokens),0)::bigint cached_input_tokens,coalesce(sum(output_tokens),0)::bigint output_tokens,coalesce(sum(reasoning_tokens),0)::bigint reasoning_tokens,coalesce(sum(other_billable_tokens),0)::bigint other_billable_tokens,coalesce(sum(estimated_cost),0)::numeric estimated_cost_usd,coalesce(avg(latency_ms),0)::numeric average_latency_ms,count(*) filter(where success)::int successes,count(*) filter(where not success)::int failures,coalesce(sum(retry_count),0)::int retries,count(*) filter(where fallback_used)::int fallbacks,count(*) filter(where throttled)::int throttled from public.ai_requests where created_at>=${from} and created_at<=${to}`,
    sql`select coalesce(sum(input_tokens+cached_input_tokens+output_tokens+reasoning_tokens+other_billable_tokens) filter(where created_at>=current_date),0)::bigint today_tokens,coalesce(sum(input_tokens+cached_input_tokens+output_tokens+reasoning_tokens+other_billable_tokens) filter(where created_at>=date_trunc('week',now())),0)::bigint week_tokens,coalesce(sum(input_tokens+cached_input_tokens+output_tokens+reasoning_tokens+other_billable_tokens) filter(where created_at>=date_trunc('month',now())),0)::bigint month_tokens,coalesce(sum(estimated_cost) filter(where created_at>=current_date),0)::numeric today_cost_usd,coalesce(sum(estimated_cost) filter(where created_at>=date_trunc('week',now())),0)::numeric week_cost_usd,coalesce(sum(estimated_cost) filter(where created_at>=date_trunc('month',now())),0)::numeric month_cost_usd from public.ai_requests`,
    sql`select date_trunc('day',created_at)::date day,coalesce(sum(input_tokens+output_tokens+cached_input_tokens+reasoning_tokens+other_billable_tokens),0)::bigint tokens,coalesce(sum(estimated_cost),0)::numeric cost_usd from public.ai_requests where created_at>=${from} and created_at<=${to} group by 1 order by 1`,
    sql`select coalesce(feature,task_type) name,count(*)::int requests,coalesce(sum(input_tokens+output_tokens+cached_input_tokens+reasoning_tokens+other_billable_tokens),0)::bigint tokens,coalesce(sum(estimated_cost),0)::numeric cost_usd from public.ai_requests where created_at>=${from} and created_at<=${to} group by 1 order by cost_usd desc nulls last,tokens desc`,
    sql`select provider,coalesce(underlying_provider,provider) underlying_provider,model,count(*)::int requests,coalesce(sum(input_tokens+output_tokens+cached_input_tokens+reasoning_tokens+other_billable_tokens),0)::bigint tokens,coalesce(sum(estimated_cost),0)::numeric cost_usd,count(*) filter(where not success)::int errors from public.ai_requests where created_at>=${from} and created_at<=${to} group by provider,coalesce(underlying_provider,provider),model order by cost_usd desc nulls last,tokens desc`,
    sql`select coalesce(requested_tier,'unclassified') tier,count(*)::int requests,coalesce(sum(input_tokens+output_tokens),0)::bigint tokens,coalesce(sum(cached_input_tokens),0)::bigint cached_tokens,coalesce(sum(estimated_cost),0)::numeric cost_usd,count(*) filter(where fallback_used)::int fallbacks from public.ai_requests where created_at>=${from} and created_at<=${to} and coalesce(feature,task_type)='professor' group by 1 order by cost_usd desc nulls last,tokens desc`,
    sql`select left(encode(digest(user_id,'sha256'),'hex'),10) user_ref,count(*)::int requests,coalesce(sum(input_tokens+output_tokens+cached_input_tokens+reasoning_tokens+other_billable_tokens),0)::bigint tokens,coalesce(sum(estimated_cost),0)::numeric cost_usd from public.ai_requests where created_at>=${from} and created_at<=${to} group by user_id order by cost_usd desc nulls last,tokens desc limit 25`,
    sql`select count(*)::int sessions,coalesce(avg(cost_usd),0)::numeric average_cost_usd,coalesce(avg(tokens),0)::numeric average_tokens from (select s.id,coalesce(sum(r.estimated_cost),0) cost_usd,coalesce(sum(r.input_tokens+r.output_tokens+r.cached_input_tokens+r.reasoning_tokens+r.other_billable_tokens),0) tokens from public.professor_sessions s left join public.ai_requests r on r.session_id=s.id where s.started_at>=${from} and s.started_at<=${to} group by s.id) economics`,
  ]);
  const config = configRows[0] || {}, usdToEur = Number(config.usd_to_eur || .92);
  const month = await sql`select coalesce(sum(estimated_cost),0)::numeric usd from public.ai_requests where created_at>=date_trunc('month',now())`;
  return NextResponse.json({ from, to, config, totals: totals[0], periods: periods[0], daily, byFeature, byProvider, byTier, byUser, sessions: sessions[0], monthlyCostEur: Number(month[0]?.usd || 0) * usdToEur });
}

export async function PATCH(request: Request) {
  const adminId = await requireAdmin();
  if (!adminId) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await ensureStudySchema();
  const body = await request.json(), number = (key: string, fallback: number) => Number.isFinite(Number(body[key])) ? Number(body[key]) : fallback;
  const policy = ["disable", "fallback", "free"].includes(body.budgetLimitPolicy) ? body.budgetLimitPolicy : "fallback";
  const primaryProvider = String(body.primaryProvider || "free").slice(0, 40), fallbackProvider = String(body.fallbackProvider || "free").slice(0, 40);
  let routing;try{routing=validateRoutingPolicy(body.routing||{})}catch(error){return NextResponse.json({error:error instanceof Error?error.message:"Invalid routing policy"},{status:400})}
  await db()`update public.ai_admin_config set monthly_budget_eur=${Math.max(0, number("monthlyBudgetEur",50))},per_user_monthly_limit_eur=${Math.max(0,number("perUserLimitEur",10))},usd_to_eur=${Math.max(.01,number("usdToEur",.92))},warning_thresholds_json=${JSON.stringify(Array.isArray(body.warningThresholds) ? body.warningThresholds.map(Number).filter((x:number)=>x>0&&x<=100) : [70,90,100])}::jsonb,professor_primary_provider=${primaryProvider},professor_primary_model=${String(body.primaryModel||"").slice(0,100)||null},professor_fallback_provider=${fallbackProvider},professor_fallback_model=${String(body.fallbackModel||"").slice(0,100)||null},budget_limit_policy=${policy},tier_pools_json=${JSON.stringify(routing.tiers)}::jsonb,fallback_enabled=${routing.fallbackEnabled},provider_allowlist_json=${JSON.stringify(routing.providerAllowlist)}::jsonb,provider_denylist_json=${JSON.stringify(routing.providerDenylist)}::jsonb,require_zdr=${routing.requireZdr},disallow_training=${routing.disallowTraining},routing_preference=${routing.routingPreference},updated_by=${adminId},updated_at=now() where singleton=true`;
  return NextResponse.json({ ok: true });
}
