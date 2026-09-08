export const PROFESSOR_TIERS = ["economy", "standard", "advanced"] as const;
export type ProfessorTier = (typeof PROFESSOR_TIERS)[number];
export type RoutingPreference = "price" | "latency" | "throughput";

export type TierPolicy = {
  models: string[];
  fallbackModels: string[];
  maxOutputTokens: number;
  maxCostPerRequestUsd: number;
};

export type ProfessorRoutingPolicy = {
  tiers: Record<ProfessorTier, TierPolicy>;
  fallbackEnabled: boolean;
  providerAllowlist: string[];
  providerDenylist: string[];
  requireZdr: boolean;
  disallowTraining: boolean;
  routingPreference: RoutingPreference;
};

const COMPLEX_PATTERN = /pharmac|farmac|medicine|medicin|chem|chimic|calculus|integral|differential|equation|equazion|proof|dimostraz|diagnos|pathophysi|fisiopat/i;

export function chooseProfessorTier(input: { kind: string; concept?: string; repeatedMisunderstandings?: number; forceAdvanced?: boolean }): ProfessorTier {
  if (input.forceAdvanced || Number(input.repeatedMisunderstandings || 0) >= 2 || COMPLEX_PATTERN.test(input.concept || "")) return "advanced";
  if (["verification_question", "classification", "easy_explanation", "outline"].includes(input.kind)) return "economy";
  return "standard";
}

function strings(value: unknown, max = 20) {
  return Array.isArray(value) ? [...new Set(value.map(String).map(x => x.trim()).filter(Boolean))].slice(0, max) : [];
}

export function validateRoutingPolicy(raw: any): ProfessorRoutingPolicy {
  const tier = (name: ProfessorTier, defaults: TierPolicy): TierPolicy => {
    const value = raw?.tiers?.[name] || raw?.tierPools?.[name] || {};
    const models = strings(value.models);
    const fallbackModels = strings(value.fallbackModels);
    const maxOutputTokens = Math.max(64, Math.min(2000, Number(value.maxOutputTokens) || defaults.maxOutputTokens));
    const maxCostPerRequestUsd = Math.max(0, Math.min(5, Number(value.maxCostPerRequestUsd) || 0));
    return { models: models.length ? models : defaults.models, fallbackModels, maxOutputTokens, maxCostPerRequestUsd };
  };
  const providerAllowlist = strings(raw?.providerAllowlist);
  const providerDenylist = strings(raw?.providerDenylist);
  if (providerAllowlist.some(x => providerDenylist.includes(x))) throw new Error("A provider cannot be both allowed and denied");
  const routingPreference = (["price", "latency", "throughput"].includes(raw?.routingPreference) ? raw.routingPreference : "price") as RoutingPreference;
  return {
    tiers: {
      economy: tier("economy", { models: ["free"], fallbackModels: ["free"], maxOutputTokens: 350, maxCostPerRequestUsd: 0 }),
      standard: tier("standard", { models: ["free"], fallbackModels: ["free"], maxOutputTokens: 650, maxCostPerRequestUsd: 0 }),
      advanced: tier("advanced", { models: ["free"], fallbackModels: ["free"], maxOutputTokens: 1100, maxCostPerRequestUsd: 0 }),
    },
    fallbackEnabled: raw?.fallbackEnabled !== false,
    providerAllowlist: providerAllowlist.length ? providerAllowlist : ["free"],
    providerDenylist,
    requireZdr: raw?.requireZdr !== false,
    disallowTraining: raw?.disallowTraining !== false,
    routingPreference,
  };
}

export function allowedModels(policy: ProfessorRoutingPolicy, tier: ProfessorTier) {
  const primary = policy.tiers[tier].models;
  return policy.fallbackEnabled ? [...new Set([...primary, ...policy.tiers[tier].fallbackModels])] : primary;
}

export function assertRouteAllowed(policy: ProfessorRoutingPolicy, tier: ProfessorTier, provider: string, model: string) {
  if (!policy.providerAllowlist.includes(provider) || policy.providerDenylist.includes(provider)) throw new Error("Provider is outside the approved Professor policy");
  if (!allowedModels(policy, tier).includes(model)) throw new Error("Model is outside the approved Professor tier");
  if (!policy.requireZdr || !policy.disallowTraining) throw new Error("Professor privacy requirements cannot be weakened");
}
