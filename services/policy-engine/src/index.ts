export { PolicyEngine, IntentInput, type EvaluateOutput, type EngineStores } from './engine.js';
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
  type DecisionLogOptions,
  type DecisionLogKeyPair,
} from './decision-log.js';
export {
  InMemorySpendStore,
  InMemoryPolicyStore,
  InMemoryAgentRegistry,
  parseWindowMs,
  type SpendRecord,
  type MaybePromise,
  type SpendStorePort,
  type PolicyStorePort,
  type AgentRegistryPort,
} from './stores.js';
// Re-exported from @rein/core (moved there so @rein/gate shares the matcher).
export { globMatch, globMatchAny } from '@rein/core';
export { buildServer } from './server.js';
