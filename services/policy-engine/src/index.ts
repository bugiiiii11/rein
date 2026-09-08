export {
  PolicyEngine,
  IntentInput,
  type EvaluateOutput,
  type ResolveOutput,
  type EngineStores,
} from './engine.js';
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
// Re-exported from @reinconsole/core (moved there so @reinconsole/gate shares the matcher).
export { globMatch, globMatchAny } from '@reinconsole/core';
export {
  buildServer,
  requiredScope,
  authFromEnv,
  approvalsFromEnv,
  resolveHost,
  type ServerOptions,
} from './server.js';
export {
  ApiKeyAuth,
  AuthError,
  InMemoryApiKeyStore,
  hashSecret,
  mintSecret,
  readCredential,
  DEFAULT_ROTATION_GRACE_MS,
  type ApiKeyStorePort,
  type AuthFailureCode,
  type IssuedApiKey,
  type ApiKeyAuthOptions,
} from './auth.js';
export {
  ApprovalService,
  ApprovalError,
  InMemoryApprovalStore,
  signApproval,
  verifyApproval,
  DEFAULT_ESCALATION_TTL_MS,
  type ApprovalChannel,
  type ApprovalStorePort,
  type ApprovalFailureCode,
  type ApprovalServiceOptions,
  type VerifiedGrant,
} from './approvals.js';
export {
  LoggingApprovalChannel,
  TelegramApprovalChannel,
  formatChallenge,
  type LoggingChannelOptions,
  type TelegramChannelOptions,
} from './channels.js';
