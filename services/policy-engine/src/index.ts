export { PolicyEngine, IntentInput, type EvaluateOutput } from './engine.js';
export {
  evaluate,
  conditionMatches,
  policyApplies,
  type SpendContext,
  type EvaluationResult,
} from './evaluator.js';
export {
  DecisionLog,
  verifyDecisionChain,
  type DecisionInput,
} from './decision-log.js';
export {
  InMemorySpendStore,
  InMemoryPolicyStore,
  InMemoryAgentRegistry,
  parseWindowMs,
  type SpendRecord,
} from './stores.js';
// Re-exported from @rein/core (moved there so @rein/gate shares the matcher).
export { globMatch, globMatchAny } from '@rein/core';
export { buildServer } from './server.js';
