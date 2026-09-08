import "server-only";

import { AiProviderError, configuredFreeProfessorProvider, configuredOpenRouterProfessorProvider, type AiGenerationRequest, type AiProvider } from "@/lib-ai";
import { budgetDecision } from "@/lib-cost-controls";
import { db } from "@/lib-db";
import { assertRouteAllowed, validateRoutingPolicy, type ProfessorTier } from "@/lib-professor-routing";

export type ProfessorProviderContext = {
  userId: string;
  documentId: string;
  sessionId: string;
  requestId: string;
  tier: ProfessorTier;
};

export interface ProfessorProviderAdapter {
  readonly name: string;
  readonly model: string;
  generate(request: AiGenerationRequest): ReturnType<AiProvider["generate"]>;
}

export async function professorProvider(context: ProfessorProviderContext): Promise<ProfessorProviderAdapter> {
  const sql=db(), configRows=await sql`select * from public.ai_admin_config where singleton=true`,config=configRows[0]||{};
  const fx=Number(config.usd_to_eur||.92), usage=await sql`select coalesce(sum(estimated_cost) filter(where created_at>=date_trunc('month',now())),0)::numeric global_usd,coalesce(sum(estimated_cost) filter(where created_at>=date_trunc('month',now()) and user_id=${context.userId}),0)::numeric user_usd from public.ai_requests`;
  const decision=budgetDecision({monthlyCostEur:Number(usage[0]?.global_usd||0)*fx,userMonthlyCostEur:Number(usage[0]?.user_usd||0)*fx,monthlyBudgetEur:Number(config.monthly_budget_eur||50),perUserLimitEur:Number(config.per_user_monthly_limit_eur||10),policy:String(config.budget_limit_policy||"fallback") as any});
  const policy=validateRoutingPolicy({tiers:config.tier_pools_json,fallbackEnabled:config.fallback_enabled,providerAllowlist:config.provider_allowlist_json,providerDenylist:config.provider_denylist_json,requireZdr:config.require_zdr,disallowTraining:config.disallow_training,routingPreference:config.routing_preference});
  const tierPolicy=policy.tiers[context.tier],freeModel="free";
  const free=():ProfessorProviderAdapter=>{assertRouteAllowed(policy,context.tier,"free",freeModel);const base=configuredFreeProfessorProvider({...context,requestedTier:context.tier});return{name:base.name,model:base.model,generate(request){return base.generate({...request,maxOutputTokens:Math.min(request.maxOutputTokens||tierPolicy.maxOutputTokens,tierPolicy.maxOutputTokens)})}}};
  if(decision.exceeded){
    if(decision.route==="disable") throw new AiProviderError("unavailable","The paid Professor budget has been reached",{provider:"openrouter"});
    return free();
  }
  if(process.env.OPENROUTER_ENABLED!=="true" || !process.env.OPENROUTER_API_KEY?.trim() || String(config.professor_primary_provider)!=="openrouter") return free();
  const underlying=policy.providerAllowlist.filter(provider=>provider!=="free"&&provider!=="openrouter");
  if(!underlying.length) throw new AiProviderError("auth","No approved OpenRouter provider is configured",{provider:"openrouter"});
  const paid=configuredOpenRouterProfessorProvider({...context,requestedTier:context.tier},{models:tierPolicy.models,underlyingProviders:underlying,deniedProviders:policy.providerDenylist,allowFallbacks:policy.fallbackEnabled,requireZdr:policy.requireZdr,routingPreference:policy.routingPreference,sessionId:context.sessionId});
  return {name:paid.name,model:paid.model,generate:request=>paid.generate({...request,maxOutputTokens:Math.min(request.maxOutputTokens||tierPolicy.maxOutputTokens,tierPolicy.maxOutputTokens)})};
}
