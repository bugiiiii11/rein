/**
 * @reinconsole/graph — the reputation graph (Phase 3).
 *
 * Guard receipts (what agents tried to spend) and gate receipts (what vendors
 * actually earned) are two halves of one dataset. The graph listens to both,
 * scores every vendor and payer it has evidence on, and feeds the scores back
 * into enforcement on both sides of the wire:
 *
 *   const graph = new ReputationGraph().observe(engine).observe(indexer);
 *   await graph.syncVendors(engine.spend);          // vendorReputationLt fires
 *   createGate({ screen: { check: payerCheck(graph) }, ... }); // door screening
 */
export {
  EvidenceLedger,
  normalizeSubject,
  subjectKey,
  type CounterpartyLine,
  type EvidenceLedgerPort,
  type MaybePromise,
  type SubjectEvidence,
} from './evidence.js';
export {
  DEFAULT_CORRELATION_LIMIT,
  InMemoryIntentStore,
  type IntentCorrelationPort,
  type IntentFacts,
} from './intents.js';
export {
  DEFAULT_WEIGHTS,
  blend,
  blendBase,
  confidence,
  disputeComponent,
  longevityComponent,
  reliabilityComponent,
  volumeComponent,
  type ScoreWeights,
} from './scoring.js';
export {
  ReputationGraph,
  payerCheck,
  type EventSource,
  type ManualReport,
  type PayerCheckOptions,
  type ReputationExplanation,
  type ReputationGraphOptions,
  type SyncOptions,
  type SyncedVendorScore,
  type VendorReputationSink,
} from './graph.js';
export {
  buildGraphServer,
  graphAuthFromEnv,
  resolveGraphHost,
  type GraphServerOptions,
} from './server.js';
