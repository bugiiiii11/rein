export {
  PolicyEngine,
  IntentInput,
  type EvaluateOutput,
  type ResolveOutput,
  type EngineStores,
  type BreakerState,
  type BreakerStateOptions,
} from './engine.js';
export {
  LivenessMonitor,
  LivenessError,
  InMemoryLivenessStore,
  type AlertChannel,
  type LivenessAlert,
  type LivenessMonitorOptions,
  type LivenessRecord,
  type LivenessRecovery,
  type LivenessState,
  type LivenessStorePort,
} from './liveness.js';
export {
  evaluate,
  conditionMatches,
  breakerTrips,
  policyApplies,
  type SpendContext,
  type BreakerWindow,
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
  InMemorySettlementStore,
  parseWindowMs,
  type SpendRecord,
  type SettlementRecord,
  type MaybePromise,
  type SpendStorePort,
  type PolicyStorePort,
  type AgentRegistryPort,
  type SettlementStorePort,
} from './stores.js';
export {
  reconcile,
  DEFAULT_SETTLEMENT_GRACE_MS,
  DEFAULT_RECONCILE_WINDOW,
  DEFAULT_RECONCILE_LIMIT,
  type AllowanceGap,
  type ReconcileOptions,
  type ReconciliationReport,
} from './reconciliation.js';
// Re-exported from @reinconsole/core (moved there so @reinconsole/gate shares the matcher).
export { globMatch, globMatchAny } from '@reinconsole/core';
export {
  buildServer,
  requiredScope,
  reconcileOptionsFromQuery,
  authFromEnv,
  approvalsFromEnv,
  livenessFromEnv,
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
  LoggingChannel,
  TelegramChannel,
  // Pre-B2 names, kept as aliases of the same classes.
  LoggingApprovalChannel,
  TelegramApprovalChannel,
  formatChallenge,
  formatAlert,
  formatSilence,
  type NotifyChannel,
  type LoggingChannelOptions,
  type TelegramChannelOptions,
} from './channels.js';
