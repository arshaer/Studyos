import assert from "node:assert/strict";
import test from "node:test";
import { allowedModels, assertRouteAllowed, chooseProfessorTier, validateRoutingPolicy } from "../src/lib-professor-routing.ts";

test("StudyOS selects the Professor tier from pedagogical context", () => {
  assert.equal(chooseProfessorTier({ kind: "verification_question", concept: "basic recall" }), "economy");
  assert.equal(chooseProfessorTier({ kind: "teaching", concept: "ordinary history" }), "standard");
  assert.equal(chooseProfessorTier({ kind: "teaching", concept: "pharmacology kinetics" }), "advanced");
  assert.equal(chooseProfessorTier({ kind: "teaching", repeatedMisunderstandings: 2 }), "advanced");
});

test("fallback remains inside the selected tier and approved provider pool", () => {
  const policy = validateRoutingPolicy({
    tiers: {
      economy: { models: ["vendor/economy"], fallbackModels: ["vendor/economy-fallback"], maxOutputTokens: 300, maxCostPerRequestUsd: 0.01 },
      standard: { models: ["vendor/standard"], fallbackModels: [], maxOutputTokens: 600, maxCostPerRequestUsd: 0.05 },
      advanced: { models: ["vendor/advanced"], fallbackModels: [], maxOutputTokens: 1000, maxCostPerRequestUsd: 0.2 },
    },
    providerAllowlist: ["openrouter"],
    requireZdr: true,
    disallowTraining: true,
  });
  assert.deepEqual(allowedModels(policy, "economy"), ["vendor/economy", "vendor/economy-fallback"]);
  assert.doesNotThrow(() => assertRouteAllowed(policy, "economy", "openrouter", "vendor/economy-fallback"));
  assert.throws(() => assertRouteAllowed(policy, "economy", "openrouter", "vendor/advanced"), /outside the approved Professor tier/);
  assert.throws(() => assertRouteAllowed(policy, "economy", "unknown", "vendor/economy"), /outside the approved Professor policy/);
});

test("Professor policy cannot silently weaken privacy", () => {
  const weakened = validateRoutingPolicy({ providerAllowlist: ["openrouter"], requireZdr: false });
  assert.throws(() => assertRouteAllowed(weakened, "economy", "openrouter", "free"), /privacy requirements/);
  assert.throws(() => validateRoutingPolicy({ providerAllowlist: ["openrouter"], providerDenylist: ["openrouter"] }), /both allowed and denied/);
});
