export type BudgetPolicy = "disable" | "fallback" | "free";

export function budgetDecision(input: {
  monthlyCostEur: number;
  userMonthlyCostEur: number;
  monthlyBudgetEur: number;
  perUserLimitEur: number;
  policy: BudgetPolicy;
}) {
  const globalExceeded = input.monthlyBudgetEur > 0 && input.monthlyCostEur >= input.monthlyBudgetEur;
  const userExceeded = input.perUserLimitEur > 0 && input.userMonthlyCostEur >= input.perUserLimitEur;
  const exceeded = globalExceeded || userExceeded;
  return {
    exceeded,
    globalExceeded,
    userExceeded,
    route: exceeded ? input.policy : "primary" as "primary" | BudgetPolicy,
  };
}

export function percentage(used: number, budget: number) {
  return budget > 0 ? Math.min(1000, Math.max(0, (used / budget) * 100)) : 0;
}
