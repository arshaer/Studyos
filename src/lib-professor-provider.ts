import "server-only";

import { AiProviderError, configuredFreeProfessorProvider, configuredPaidProfessorProvider, type AiGenerationRequest, type AiProvider } from "@/lib-ai";
import { budgetDecision } from "@/lib-cost-controls";
import { db } from "@/lib-db";

export type ProfessorProviderContext = {
  userId: string;
  documentId: string;
  sessionId: string;
  requestId: string;
};

export interface ProfessorProviderAdapter {
  readonly name: string;
  readonly model: string;
  generate(request: AiGenerationRequest): ReturnType<AiProvider["generate"]>;
}

/**
 * Pre-paid implementation: Professor runs through the existing free gateway.
 * Paid activation is deliberately isolated here and remains disabled until the
 * rest of Professor V2 has passed its checkpoint.
 */
export async function professorProvider(context: ProfessorProviderContext): Promise<ProfessorProviderAdapter> {
  const sql=db(), configRows=await sql`select * from public.ai_admin_config where singleton=true`,config=configRows[0]||{};
  const fx=Number(config.usd_to_eur||.92), usage=await sql`select coalesce(sum(estimated_cost) filter(where created_at>=date_trunc('month',now())),0)::numeric global_usd,coalesce(sum(estimated_cost) filter(where created_at>=date_trunc('month',now()) and user_id=${context.userId}),0)::numeric user_usd from public.ai_requests`;
  const decision=budgetDecision({monthlyCostEur:Number(usage[0]?.global_usd||0)*fx,userMonthlyCostEur:Number(usage[0]?.user_usd||0)*fx,monthlyBudgetEur:Number(config.monthly_budget_eur||50),perUserLimitEur:Number(config.per_user_monthly_limit_eur||10),policy:String(config.budget_limit_policy||"fallback") as any});
  const free=()=>configuredFreeProfessorProvider(context);
  if(process.env.PROFESSOR_PAID_ENABLED!=="true" || String(config.professor_primary_provider||"free")==="free") return free();
  if(decision.exceeded){
    if(decision.route==="disable") throw new AiProviderError("unavailable","The paid Professor budget has been reached",{provider:"openai"});
    return free();
  }
  return configuredPaidProfessorProvider(context);
}
