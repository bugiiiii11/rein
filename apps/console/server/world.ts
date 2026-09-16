/**
 * The console "world": one live instance of the whole Rein stack wired together
 * — the real policy engine (over HTTP, exactly as an SDK client would reach it),
 * the real Gate fronting the world's vendor API (priced routes, screening,
 * replay burn), the session-key signer holding a custodied wallet, and the mock
 * rails (ledger, facilitator, indexer) standing in for the chain. It subscribes
 * to every bus — engine (`intent.created`, `decision.made`), indexer
 * (`payment.settled`, `shadow.spend`), gate (`gate.*`), signer (`signature.*`)
 * — normalizes them into render-ready feed items, and broadcasts to any
 * connected SSE clients.
 *
 * Two custody tiers pay the same gated vendor:
 *   - SDK tier: agents hold their own (mock) wallet; the facilitator settles
 *     flat mock payloads. Bypass is possible — and detected (shadow.spend).
 *   - Session-key tier: the signer holds the wallet; payments are real
 *     EIP-3009 signatures released only against engine-signed vouchers. The
 *     gate's rails verify those signatures cryptographically (offline) before
 *     settling — a forged or tampered authorization genuinely fails here.
 *
 * This is the only place the moving parts are assembled; the HTTP/SSE layer in
 * `api.ts` is a thin shell over the methods returned here.
 */
import type { AddressInfo } from 'node:net';
import { recoverTypedDataAddress, type Hex } from 'viem';
import { generatePrivateKey } from 'viem/accounts';
import {
  formatErc8004Id,
  newId,
  type ApprovalRequest,
  parseErc8004Id,
  sumDecimal,
  type Agent,
  type Chain,
  type Decision,
  type PaymentIntent,
  type Receipt,
  type ReputationSubject,
} from '@reinconsole/core';
import {
  BASE_SEPOLIA_REGISTRY,
  MockIdentityRegistry,
  REIN_SCORE_TAG,
  identityRegistryReader,
  linkAgentFromRegistry,
  linkVendorFromRegistry,
  readSummary,
} from '@reinconsole/erc8004';
import {
  ApprovalService,
  LivenessMonitor,
  PolicyEngine,
  buildServer,
  parseWindowMs,
} from '@reinconsole/policy-engine';
import {
  createGuard,
  PaymentBlockedError,
  atomicToDecimal,
  networkToChain,
  requirementDecimals,
  resolveAsset,
  PaymentRequirementsV2,
  type FetchLike,
  type Payer,
  type PaymentRequirement,
} from '@reinconsole/sdk';
import { MockLedger, MockFacilitator, MockIndexer } from '@reinconsole/mock-rails';
import {
  createGate,
  createGatedFetch,
  mockFacilitatorRails,
  GateError,
  type GateRails,
} from '@reinconsole/gate';
import { ReputationGraph, payerCheck } from '@reinconsole/graph';
import { openReinStore } from '@reinconsole/store';
import {
  SessionSigner,
  sessionPayerFor,
  sessionState,
  SignerError,
  type SignRequest,
} from '@reinconsole/signer';
import {
  chainIdForNetwork,
  createBaseSepoliaClient,
  encodeSettlementHeader,
  intentNonce,
  transferWithAuthorizationTypes,
  PaymentPayload,
} from '@reinconsole/x402-rails';
import type {
  AgentLivenessView,
  AgentView,
  AllowanceGapView,
  BreakerView,
  ConsoleState,
  DemoStatus,
  EscalationView,
  EscalationsView,
  FeedItem,
  GateView,
  GraphView,
  PolicyView,
  PolicyRuleView,
  ReconciliationView,
  ReputationRow,
  ServerEvent,
  SignerSessionView,
  SignerView,
  Stats,
} from './wire';

const VENDOR_HOST = 'api.data.test';
const VENDOR_URL = `https://${VENDOR_HOST}/v1/query`;
const PREMIUM_URL = `https://${VENDOR_HOST}/v1/premium`;
const PRICE = '0.01';
const PREMIUM_PRICE = '5.00';
const PRICE_ATOMIC = '10000'; // $0.01 USDC (6 decimals)
const PREMIUM_PRICE_ATOMIC = '5000000'; // $5.00 USDC (6 decimals)
/** USDC on Base — built into the SDK's asset resolution, and a real EIP-712
 * verifying contract for the session-key lane (lowercased: no checksum trips). */
const USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
/** Real-hex addresses: the EIP-3009 lane signs typed data over them. */
const TREASURY = '0x7e57000000000000000000000000000000000001';
const MULE_WALLET = '0xbad0000000000000000000000000000000000666';
const BURST_WALLET = '0xb00570000000000000000000000000000000feed';
const TX_CAP = '0.50';
const HOUR_BUDGET = '0.04';
const SESSION_CAP = '0.02';
/** Per-payer settled-spend velocity cap at the gate (rolling hour). Sits just
 * ABOVE the engine's HOUR_BUDGET on purpose: guarded agents are budget-denied
 * at $0.04/h before any payment exists, so only an unguarded payer — the
 * scenario's burst buyer — can ever trip this. */
const VELOCITY_CAP = '0.05';
const FEED_CAP = 300;

/**
 * The behavioral breaker every managed agent carries, so the console has a
 * live envelope to render (A3).
 *
 * Sized DELIBERATELY loose: six transactions a day, where the boot scenario
 * spends four and the `hour-budget` deny rail (rollingSum > $0.04, i.e. four
 * $0.01 calls) is far tighter. So this breaker counts, and is visibly counted
 * against, without changing a single decision the world makes — the pinned
 * boot fingerprint (8 allow / 3 deny / 0 escalate) is a contract this panel
 * must not quietly rewrite. A breaker tight enough to TRIP in the console
 * scenario is a separate, deliberate change: it would turn an allowed call
 * into a parked escalation and rewrite that fingerprint end to end.
 */
const AGENT_BREAKERS = [{ id: 'velocity', window: '24h', txCount: 6 }] as const;

/**
 * The one org this console's world belongs to.
 *
 * Every agent and the registered approver share it, and that is not cosmetic:
 * tenant isolation (S56) scopes policies, decisions and approvals by org, and
 * an approver key in a different org than the agent it answers for cannot
 * release that agent's parked payment at all. Minting a throwaway `newId('org')`
 * per agent — what this file did while `orgId` was a field nobody read — would
 * now put every agent in a tenant of its own and leave the approver outside all
 * of them.
 */
const WORLD_ORG = newId('org');

/** The reputation cast, seeded with BACKDATED history at boot (same-day
 * evidence is confidence-discounted to 40%, by design — see @reinconsole/graph):
 * a reputable feed, a sketchy broker that pockets most payments, and a wallet
 * that burned replay slots at OTHER vendors' gates. */
const GOOD_VENDOR = 'good-feeds.test';
const SKETCHY_VENDOR = 'shady-data.test';
const OFFENDER_WALLET = '0xdefec7ed0000000000000000000000000000d00d';
/** Floor shared by the policy rule (vendorReputationLt) and the gate's payerCheck. */
const REP_FLOOR = 40;
/** Scores below this confidence are never enforced — thin history stays unknown. */
const REP_MIN_CONFIDENCE = 0.3;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/**
 * Reconciliation (B1). How long an allowance may go unsettled before the
 * console calls it a gap rather than a payment in flight, and how often the
 * gaps are re-measured.
 *
 * A gap has to AGE into existence — nothing emits when a payment fails to
 * happen, which is exactly why this needs a sweep and the other panels do not.
 * The default grace is deliberately far longer than these mock rails need
 * (they settle in the same tick): the number that matters is a real
 * facilitator's, and a console that cried gap after 200ms would be measuring
 * its own simulator.
 */
const RECONCILE_GRACE_MS = Number(process.env['REIN_RECONCILE_GRACE_MS'] ?? 60_000);
const RECONCILE_SWEEP_MS = Number(process.env['REIN_RECONCILE_SWEEP_MS'] ?? 30_000);
/** The trailing span of allowances the panel covers. */
const RECONCILE_WINDOW = '24h' as const;

/**
 * Dead-man monitoring (B2), and which agents get watched at all.
 *
 * Only the RESEARCH agents. That is the whole design decision: an expectation
 * is declared, never inferred, and most agents here are episodic — the session
 * agent exists to demonstrate custody and the procurement agent to demonstrate
 * reputation, and neither promised anyone a cadence. A research poller did.
 * Watching all three would put three permanent alarms on a console whose
 * scenario ends by design, which teaches an operator to ignore the panel.
 *
 * The interval is short enough that a visitor watching a fresh boot sees the
 * transition happen (and the alarm land in the feed), and the console is
 * honest about the result: after the scenario the research agent really has
 * stopped. Pressing Ping on it is a real recovery, not a reset button — the
 * ping submits an intent, and an intent is a sighting whatever the policy
 * decides about it.
 */
const LIVENESS_LABEL = 'research';
const LIVENESS_INTERVAL = (process.env['REIN_LIVENESS_INTERVAL'] ?? '5m') as `${number}m`;
const LIVENESS_GRACE_MS = Number(process.env['REIN_LIVENESS_GRACE_MS'] ?? 60_000);
const LIVENESS_SWEEP_MS = Number(process.env['REIN_LIVENESS_SWEEP_MS'] ?? 15_000);
const LIVENESS_NOTE = 'polls the vendor feed on a schedule';

/**
 * Human-in-the-loop escalations (A2), and the agent that produces one (B3).
 *
 * The three scenario agents carry AGENT_BREAKERS, which is sized to count
 * without tripping — deliberately, because a trip there would turn an allowed
 * call into a parked escalation and rewrite the whole pinned fingerprint. The
 * exhibit gets its OWN agent instead: a new hire on a probationary envelope of
 * two purchases an hour. Two go through, the third asks a human, and the three
 * agents above keep every number they had.
 *
 * Why an agent rather than a tighter breaker on an existing one: a breaker is
 * an envelope declared for a role, and a role whose envelope is regularly
 * exceeded is a misconfiguration, not a demo. A probationary agent is the one
 * case where escalating on the third purchase is the intended behaviour.
 */
const PROBATION_BREAKERS = [{ id: 'probation', window: '1h', txCount: 2 }] as const;

/**
 * How long a parked payment stays answerable here. Far longer than the
 * engine's 10-minute default, on purpose: this console is an exhibit that runs
 * for days, and a visitor arriving eleven minutes after a deploy would find an
 * empty panel and learn nothing about the state it exists to show. The
 * fail-closed half of the guarantee — expiry DENIES, and denies on the chain —
 * is pinned by tests and shown in the mock demo, which is where a guarantee
 * belongs; it does not need a public dashboard's clock to demonstrate it. When
 * the day does lapse, the expiry deny lands in the feed and the request moves
 * to the panel's resolved list, which is the honest end of the story.
 */
const ESCALATION_TTL_MS = Number(process.env['REIN_ESCALATION_TTL_MS'] ?? 24 * 3_600_000);
/** How many resolved escalations the panel keeps behind the pending ones. */
const ESCALATION_HISTORY = 6;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Governed refusals are the world working as designed — not errors. */
function swallowGoverned(e: unknown): void {
  if (!(e instanceof PaymentBlockedError) && !(e instanceof SignerError)) throw e;
}

/** A handcrafted flat mock payment header (what a rogue client would forge). */
function craftPayment(from: string, value: string): string {
  return Buffer.from(
    JSON.stringify({
      x402Version: 1,
      scheme: 'exact',
      network: 'base',
      payload: { from, to: TREASURY, value, asset: USDC_BASE },
    }),
  ).toString('base64');
}

/** EIP-712 domain name/version travel in requirement.extra (per the v1 spec). */
function extraString(requirement: PaymentRequirement, key: string): string | undefined {
  const value = requirement.extra?.[key];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Decode an EIP-3009 payment header in EITHER x402 dialect, or undefined for
 * anything else (flat mock payloads fall through to the mock decoder, which
 * speaks both dialects itself). A v2 envelope (PAYMENT-SIGNATURE) wraps the
 * SAME signed scheme payload as v1, so it unwraps to the inner shape here —
 * mirrors mock-rails' decodePaymentHeader normalization.
 */
export function decodeEvmPayment(header: string): PaymentPayload | undefined {
  try {
    let json: unknown = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
    const v2 = json as { x402Version?: unknown; accepted?: unknown; payload?: unknown } | null;
    if (v2?.x402Version === 2) {
      const accepted = PaymentRequirementsV2.safeParse(v2.accepted);
      if (!accepted.success) return undefined;
      json = {
        x402Version: 1,
        scheme: accepted.data.scheme,
        network: accepted.data.network,
        payload: v2.payload,
      };
    }
    const parsed = PaymentPayload.safeParse(json);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

interface AgentRuntime {
  wallet: string;
  /** A guard-wrapped fetch bound to this agent against the gated vendor. */
  ping: () => Promise<void>;
}

export interface World {
  getState(): ConsoleState;
  subscribe(listener: (ev: ServerEvent) => void): () => void;
  freeze(agentId: string): Promise<boolean>;
  unfreeze(agentId: string): Promise<boolean>;
  pingAgent(agentId: string): Promise<boolean>;
  /**
   * Submit a signed verdict for a parked escalation. The console carries the
   * bytes; the signature is made wherever the approver's private key lives.
   * Throws `ApprovalError` for every refusal — the request stays parked.
   */
  submitGrant(grant: {
    decisionId: string;
    intentHash: string;
    verdict: 'approve' | 'reject';
    approverKeyId: string;
    signature: string;
  }): Promise<{ status: string; finalDecisionId: string }>;
  runDemo(): boolean;
  close(): Promise<void>;
}

export interface WorldOptions {
  /**
   * PGlite data directory. When set, the WHOLE world runs on @reinconsole/store —
   * the policy engine (agents, policies, decision chain, rolling spend), the
   * reputation graph (evidence + intent correlation), the gate (receipts,
   * revenue, replay slots), and the signer (sessions, spend accounting,
   * burned vouchers) all survive restarts; the boot seed + scenario run only
   * when the store is fresh. Omit for the classic in-memory world.
   *
   * The feed and mock ledger stay ephemeral either way (this process's
   * telemetry, not state). Resumed agents are PINGABLE: SDK-tier runtimes
   * rebuild from the persisted wallet address, and session-tier agents get a
   * ROTATED key + fresh session at boot — custody private keys are
   * deliberately never persisted, and identity linking keeps one reputation
   * across the rotation.
   */
  dataDir?: string;
}

export async function createWorld(options: WorldOptions = {}): Promise<World> {
  const store = options.dataDir ? await openReinStore({ dir: options.dataDir }) : undefined;
  // The monitor is composed here rather than handed over by the store: the
  // durable half is only the expectations and sightings, while the alarm's
  // channels and its once-per-silence bookkeeping are this world's to choose.
  // The console's channel is the feed itself (see sweepLiveness).
  const liveness = new LivenessMonitor({
    ...(store ? { store: store.livenessStore } : {}),
    onSightingError: (agentId, err) =>
      console.error(`[console] liveness sighting for ${agentId} was not recorded:`, err),
  });
  /**
   * The approval tier (A2). Composed here for the same reason the liveness
   * monitor is: the store holds only the parked requests and the registered
   * keys, while the TTL and the delivery channels are this world's to choose.
   *
   * No channels: the console's channel is the panel itself, and the feed row
   * the escalating decision already wrote. Wiring Telegram here would page a
   * human about a scripted demo — the standalone engine is where a real
   * channel belongs (`REIN_TELEGRAM_BOT_TOKEN`).
   */
  const approvals = new ApprovalService({
    ...(store ? { store: store.approvalStore } : {}),
    ttlMs: ESCALATION_TTL_MS,
    onDeliveryError: (channel, err) =>
      console.error(`[console] approval channel ${channel} failed:`, err),
  });
  const engine = store
    ? new PolicyEngine({ ...store, liveness, approvals })
    : new PolicyEngine({ liveness, approvals });
  const app = buildServer(engine);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const engineUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;

  const ledger = new MockLedger();
  const facilitator = new MockFacilitator({ ledger, name: 'mock-facilitator' });
  const indexer = new MockIndexer({
    ledger,
    agents: () => engine.agents.list(),
    facilitator: facilitator.name,
  });
  indexer.connectEngine(engine);

  // The signer holds session-tier wallet keys; vouchers verify against the
  // engine's pinned public key — the same one the console's audit panel shows.
  // On a persistent world, sessions/spend/burned vouchers ride the store; the
  // KEYS never do (rotated at boot — see rebuildRuntime).
  const signer = new SessionSigner({
    enginePublicKeyPem: engine.publicKeyPem,
    ...(store ? { store: store.sessions } : {}),
  });

  // The reputation graph (Phase 3) watches every bus in this world. Scores are
  // pure functions of the evidence it accumulates — recomputed per call, never
  // stored — and feed back into enforcement on both sides: vendor scores sync
  // into the engine (vendorReputationLt fires), payer scores screen the gate.
  // On a persistent world the SAME store backs the evidence ledger, so the
  // scoreboard survives restarts alongside the engine state it governs.
  const graph = store
    ? new ReputationGraph({ ledger: store.ledger, intents: store.intents })
    : new ReputationGraph();

  // EIP-3009 nonces are keccak256(intent.id); remembering the mapping lets the
  // rails settle session-tier payments onto the ledger with the intent-id memo
  // the indexer reconciles on — the mock twin of on-chain nonce reconciliation.
  const intentIdOfNonce = new Map<string, string>();

  /**
   * The gate's settlement seam, dual-dialect: flat mock payloads go through the
   * MockFacilitator exactly as before; EIP-3009 payloads from the signer are
   * verified cryptographically right here (recover the typed-data signer, check
   * the validity window — what USDC's contract would enforce on-chain) and
   * settled straight onto the mock ledger.
   */
  function worldRails(): GateRails {
    const mock = mockFacilitatorRails(facilitator);
    return {
      async verify(header, requirement) {
        const evm = decodeEvmPayment(header);
        if (!evm) return mock.verify(header, requirement);
        const auth = evm.payload.authorization;
        const chainId = chainIdForNetwork(evm.network);
        if (chainId === undefined) {
          throw new GateError('verify_failed', `cannot verify on network "${evm.network}"`);
        }
        let recovered: string;
        try {
          recovered = await recoverTypedDataAddress({
            domain: {
              name: extraString(requirement, 'name') ?? 'USDC',
              version: extraString(requirement, 'version') ?? '2',
              chainId,
              verifyingContract: requirement.asset as Hex,
            },
            types: transferWithAuthorizationTypes,
            primaryType: 'TransferWithAuthorization',
            message: {
              from: auth.from as Hex,
              to: auth.to as Hex,
              value: BigInt(auth.value),
              validAfter: BigInt(auth.validAfter),
              validBefore: BigInt(auth.validBefore),
              nonce: auth.nonce as Hex,
            },
            signature: evm.payload.signature as Hex,
          });
        } catch (err) {
          throw new GateError(
            'verify_failed',
            `EIP-3009 signature did not parse: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        if (recovered.toLowerCase() !== auth.from.toLowerCase()) {
          throw new GateError(
            'verify_failed',
            'signature does not recover to the payer — forged or tampered authorization',
          );
        }
        const now = Math.floor(Date.now() / 1000);
        if (now < Number(auth.validAfter) || now >= Number(auth.validBefore)) {
          throw new GateError('verify_failed', 'authorization is outside its validity window');
        }
      },
      async settle(header, requirement) {
        const evm = decodeEvmPayment(header);
        if (!evm) return mock.settle(header, requirement);
        const auth = evm.payload.authorization;
        const chain = networkToChain(evm.network);
        const asset = resolveAsset(requirement);
        if (!chain || !asset) {
          throw new GateError(
            'settle_failed',
            `cannot settle "${requirement.asset}" on "${evm.network}"`,
          );
        }
        const entry = ledger.transfer({
          chain,
          asset,
          from: auth.from,
          to: auth.to,
          amount: atomicToDecimal(auth.value, requirementDecimals(requirement)),
          memo: intentIdOfNonce.get(auth.nonce.toLowerCase()),
        });
        const response = {
          success: true,
          transaction: entry.txHash,
          network: evm.network,
          payer: auth.from,
        };
        return {
          header: encodeSettlementHeader(response),
          transaction: entry.txHash,
          network: evm.network,
          payer: auth.from,
        };
      },
    };
  }

  // ONE gated vendor fronts the whole world: two priced routes, a denylisted
  // mule, real receipts. Both custody tiers pay it; crawlers get quoted.
  const gate = createGate({
    routes: [
      { path: '/v1/query', price: PRICE, description: 'one data query' },
      { path: '/v1/premium', price: PREMIUM_PRICE, description: 'premium intelligence report' },
    ],
    rails: worldRails(),
    payTo: TREASURY,
    network: 'base',
    asset: USDC_BASE,
    screen: {
      denyPayers: [MULE_WALLET],
      // Dynamic screening: a confidently low-rep wallet is turned away at the
      // door before any settle leg; unknowns and thin histories always pass.
      check: payerCheck(graph, { denyBelow: REP_FLOOR, minConfidence: REP_MIN_CONFIDENCE }),
    },
    // Gate-wide per-payer velocity (S19). Refusals fire BEFORE the replay burn
    // and, by the graph's fairness skip-set, leave no reputation evidence.
    velocity: { windowMs: HOUR_MS, maxAmount: VELOCITY_CAP },
    // Persistent world: receipts/revenue resume, and a payment settled before
    // a kill is refused as a replay after the restart.
    ...(store ? { store: store.gate } : {}),
  });
  const gatedFetch = createGatedFetch(gate, {
    serve: ({ url }) =>
      new Response(
        JSON.stringify(
          new URL(url).pathname === '/v1/premium'
            ? { report: 'premium intelligence', confidence: 0.97 }
            : { rows: 42 },
        ),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
  });

  // ── server-side derived state ────────────────────────────────────────────
  const startedAt = new Date().toISOString();
  const intents = new Map<string, PaymentIntent>();
  const spend = new Map<string, string[]>(); // agentId -> allowed amounts
  const runtimes = new Map<string, AgentRuntime>();
  const feed: FeedItem[] = [];
  const listeners = new Set<(ev: ServerEvent) => void>();
  let seq = 0;
  // Resume the run counter from resumed agent names so a restarted persistent
  // world's next run doesn't mint a duplicate "research-agent-1".
  let demoRuns = engine.agents.list().reduce((max, a) => {
    const m = /^research-agent-(\d+)$/.exec(a.name);
    return m ? Math.max(max, Number(m[1])) : max;
  }, 0);
  let demo: DemoStatus = { running: false, phase: 'idle' };
  let syncTimer: ReturnType<typeof setTimeout> | undefined;
  let lastSyncAt: string | null = null;
  /** Hosts whose scores the engine currently holds (pushed by syncVendors). */
  const syncedHosts = new Set<string>();

  function emit(ev: ServerEvent): void {
    for (const l of listeners) l(ev);
  }

  function agentName(id: string | undefined): string | undefined {
    if (!id) return undefined;
    return engine.agents.list().find((a) => a.id === id)?.name;
  }

  function agentByWallet(address: string | undefined): Agent | undefined {
    if (!address) return undefined;
    const key = address.toLowerCase();
    return engine.agents
      .list()
      .find((a) => a.wallets.some((w) => w.address.toLowerCase() === key));
  }

  /**
   * Settlement writes, chained. The indexer's callback is synchronous but a
   * durable settlement write is not, so boot awaits this tail before handing
   * the world over — otherwise the first snapshot could report a payment as
   * unsettled purely because its write had not landed yet.
   */
  let settlementTail: Promise<unknown> = Promise.resolve();

  function reportSettlement(report: {
    intentId: string;
    txHash?: string;
    chain?: Chain;
    amount?: string;
    source: string;
    confirmedAt: Date;
  }): void {
    settlementTail = settlementTail.then(() =>
      engine.recordSettlement(report).catch((err: unknown) => {
        // A lost report leaves the allowance looking like a gap, which is the
        // safe direction: an operator sees a payment to check, never a
        // payment silently marked good.
        console.error('[console] settlement report failed (gap stays open):', err);
      }),
    );
  }

  function pushFeed(item: FeedItem): void {
    feed.push(item);
    if (feed.length > FEED_CAP) feed.shift();
    emit({ type: 'feed', item });
    emit({ type: 'agents', agents: viewAgents() });
    emit({ type: 'stats', stats: computeStats() });
  }

  /**
   * Where one agent stands against its cadence (B2), or nothing at all when
   * nobody watches it. Absence is meaningful here: it means unwatched, not
   * healthy, which is why the card renders no liveness chip rather than a
   * green one.
   */
  function viewLiveness(agentId: string, now: number): AgentLivenessView | undefined {
    const state = liveness.state(agentId, now);
    if (!state) return undefined;
    return {
      interval: state.expectation.interval,
      status: state.status,
      silentMs: state.silentMs,
      ...(state.lastSeenAt !== undefined
        ? { lastSeenAt: new Date(state.lastSeenAt).toISOString() }
        : {}),
      ...(state.lastSource !== undefined ? { lastSource: state.lastSource } : {}),
      ...(state.expectation.note !== undefined ? { note: state.expectation.note } : {}),
    };
  }

  function viewAgents(): AgentView[] {
    // One clock for the whole render, as in viewBreakers: two agents in the
    // same frame must not disagree about what time it is.
    const now = Date.now();
    return engine.agents.list().map((a: Agent): AgentView => {
      const amounts = spend.get(a.id) ?? [];
      const wallet = a.wallets[0];
      const live = viewLiveness(a.id, now);
      return {
        id: a.id,
        name: a.name,
        labels: a.labels,
        status: engine.agents.isFrozen(a.id) ? 'frozen' : 'active',
        mode: wallet?.mode ?? 'observed',
        chain: wallet?.chain ?? '—',
        address: wallet?.address ?? '',
        spent: sumDecimal(amounts),
        calls: amounts.length,
        createdAt: a.createdAt.toISOString(),
        ...(live ? { liveness: live } : {}),
      };
    });
  }

  function summarizeRule(rule: {
    id: string;
    allow?: unknown;
    deny?: unknown;
    escalate?: unknown;
  }): PolicyRuleView {
    const action: PolicyRuleView['action'] = rule.deny ? 'deny' : rule.escalate ? 'escalate' : 'allow';
    const cond = (rule.deny ?? rule.escalate ?? rule.allow) as Record<string, unknown> | undefined;
    return { id: rule.id, action, summary: summarizeCondition(cond) };
  }

  function summarizeCondition(c: Record<string, unknown> | undefined): string {
    if (!c) return 'always';
    const parts: string[] = [];
    if (typeof c.amountGt === 'string') parts.push(`amount > $${c.amountGt}`);
    const rolling = c.rollingSum as { window: string; gt: string } | undefined;
    if (rolling) parts.push(`rolling ${rolling.window} > $${rolling.gt}`);
    const txc = c.txCount as { window: string; gt: number } | undefined;
    if (txc) parts.push(`${txc.gt} tx / ${txc.window}`);
    if (Array.isArray(c.vendorHostIn)) parts.push(`vendor in ${c.vendorHostIn.join(', ')}`);
    if (c.vendorFirstSeen === true) parts.push('first-seen vendor');
    if (typeof c.vendorReputationLt === 'number') parts.push(`reputation < ${c.vendorReputationLt}`);
    return parts.length > 0 ? parts.join(' AND ') : 'matches';
  }

  function viewPolicies(): PolicyView[] {
    return engine.policies.list().map((p): PolicyView => ({
      policyId: p.policyId,
      version: p.version,
      default: p.default,
      agents: p.appliesTo.agents ?? [],
      labels: p.appliesTo.labels ?? [],
      rules: p.rules.map(summarizeRule),
    }));
  }

  function viewGate(): GateView {
    const s = gate.stats();
    return {
      payTo: TREASURY,
      network: 'base',
      quoted: s.quoted,
      settled: s.settled,
      refused: s.refused,
      // Keyed by asset AS QUOTED (the USDC contract address here) — this world
      // is single-asset, so the total is just the sum across keys.
      revenue: sumDecimal(Object.values(s.revenue)),
      routes: Object.entries(s.routes).map(([route, line]) => ({ route, ...line })),
      payers: Object.entries(s.payers).map(([payer, line]) => ({
        payer,
        agentName: agentByWallet(payer)?.name,
        ...line,
      })),
    };
  }

  /** signature.released counts per session — process-local telemetry, like the feed. */
  const sessionBurns = new Map<string, number>();

  function viewSigner(): SignerView {
    const nowMs = Date.now();
    const sessions = signer
      .sessions()
      .map(
        (s): SignerSessionView => ({
          id: s.id,
          agentId: s.agentId,
          agentName: agentName(s.agentId),
          wallet: signer.walletAddress(s.agentId) ?? '',
          cap: s.capAmount,
          spent: signer.sessionSpent(s.id),
          status: sessionState(s, nowMs),
          burns: sessionBurns.get(s.id) ?? 0,
          createdAt: s.createdAt.toISOString(),
          expiresAt: s.expiresAt.toISOString(),
        }),
      )
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    return { sessions, active: sessions.filter((s) => s.status === 'active').length };
  }

  /** gate.refused events carry no amount, but the route table still knows what
   * the refused caller was buying — quote it so TURNED AWAY rows show a price. */
  function quotedAmount(resource: string | undefined): string | undefined {
    if (!resource) return undefined;
    const requirement = gate.quoteFor('GET', `https://${VENDOR_HOST}${resource}`);
    return (
      requirement && atomicToDecimal(requirement.maxAmountRequired, requirementDecimals(requirement))
    );
  }

  function reputationRow(subject: ReputationSubject): ReputationRow | undefined {
    const explained = graph.explain(subject);
    if (!explained) return undefined;
    const { score, evidence } = explained;
    // Linked identities (erc8004 id <- ULID <- wallets, vendor host <- payTo)
    // merge into ONE row now. Registered agents key by their on-chain identity,
    // so the primary label lookup is by erc8004Id. The wallet/treasury
    // fallbacks below only fire for UNLINKED subjects — wallets with no
    // registered agent (the offender, the mule) and foreign payTo addresses.
    // If several local agents claim ONE registration (merged row), the first
    // claimant labels the row — deterministic, and unreachable via console
    // paths (every provision mints a distinct tokenId).
    const byErc8004 =
      subject.kind === 'agent'
        ? engine.agents.list().find((a) => a.erc8004Id === subject.id)
        : undefined;
    const byWallet = agentByWallet(subject.id)?.name;
    const label =
      subject.kind === 'agent'
        ? byErc8004?.name ?? agentName(subject.id) ?? (byWallet ? `${byWallet} (wallet)` : undefined)
        : subject.id === TREASURY
          ? 'gate treasury (payTo)'
          : undefined;
    return {
      kind: subject.kind,
      id: subject.id,
      label,
      erc8004: byErc8004 !== undefined,
      score: score.score,
      confidence: score.confidence,
      components: score.components,
      attempts: evidence.attempts,
      settled: evidence.settled,
      volume: evidence.volume,
      refusals: Object.values(evidence.refusals).reduce((a, b) => a + b, 0),
      shadowSpends: evidence.shadowSpends,
      disputes: evidence.disputes,
      endorsements: evidence.endorsements,
      firstSeen: evidence.firstSeen.toISOString(),
      synced: subject.kind === 'vendor' && syncedHosts.has(subject.id),
      barred:
        subject.kind === 'agent' &&
        score.confidence >= REP_MIN_CONFIDENCE &&
        score.score < REP_FLOOR,
    };
  }

  function viewGraph(): GraphView {
    const rows = (kind: 'vendor' | 'agent') =>
      graph
        .scores(kind) // best first
        .map((s) => reputationRow(s.subject))
        .filter((r): r is ReputationRow => r !== undefined);
    return {
      subjects: graph.subjects(),
      vendors: rows('vendor'),
      agents: rows('agent'),
      syncedCount: syncedHosts.size,
      lastSyncAt,
      minConfidence: REP_MIN_CONFIDENCE,
      denyBelow: REP_FLOOR,
    };
  }

  /**
   * Where every agent's breakers stand (A3). One clock for the whole sweep, so
   * two agents in the same render can never disagree about when the window
   * starts. Selection is first-applicable, exactly as in evaluation — the
   * console's policies are unscoped, so the default `base` probe finds them.
   */
  function viewBreakers(): BreakerView[] {
    const now = Date.now();
    return engine.agents.list().flatMap((a) =>
      engine.breakerStates(a.id, { now }).map(
        (s): BreakerView => ({
          agentId: a.id,
          agentName: a.name,
          breakerId: s.breaker.id,
          policyId: s.policyId,
          window: s.breaker.window,
          ...(s.breaker.txCount !== undefined ? { txCap: s.breaker.txCount } : {}),
          ...(s.breaker.valueCap !== undefined ? { valueCap: s.breaker.valueCap } : {}),
          txCount: s.txCount,
          sum: s.sum,
          countingFrom: new Date(s.countingFrom).toISOString(),
          ...(s.resetAt !== undefined ? { resetAt: new Date(s.resetAt).toISOString() } : {}),
          tripped: s.tripped,
          ...(s.reason !== undefined ? { reason: s.reason } : {}),
        }),
      ),
    );
  }

  /**
   * Where the allowance ledger and the settlement facts disagree (B1).
   *
   * All-time by the two-window rule: both halves of the join are durable
   * state, so a resumed console reports on the payments it authorized before
   * the restart — which is precisely when an unanswered allowance matters
   * most, and precisely what a feed-derived counter could not have told it.
   */
  function viewReconciliation(now = Date.now()): ReconciliationView {
    const report = engine.reconcile({
      window: RECONCILE_WINDOW,
      graceMs: RECONCILE_GRACE_MS,
      now,
    });
    return {
      window: report.window,
      graceMs: report.graceMs,
      allowed: report.allowed,
      allowedValue: report.allowedValue,
      settled: report.settled,
      settledValue: report.settledValue,
      inFlight: report.inFlight,
      inFlightValue: report.inFlightValue,
      unsettled: report.unsettled,
      unsettledValue: report.unsettledValue,
      unattributed: report.unattributed,
      settlementsSeen: report.settlementsSeen,
      gaps: report.gaps.map(
        (g): AllowanceGapView => ({
          intentId: g.intentId,
          ...(g.decisionId !== undefined ? { decisionId: g.decisionId } : {}),
          agentId: g.agentId,
          agentName: agentName(g.agentId) ?? g.agentId,
          host: g.host,
          resource: g.resource,
          amount: g.amount,
          allowedAt: new Date(g.allowedAt).toISOString(),
          ageMs: g.ageMs,
          state: g.state,
        }),
      ),
      at: new Date(now).toISOString(),
    };
  }

  /**
   * Payments the engine refused to decide alone (A2), rendered for B3.
   *
   * Read-only by construction, and that is the design rather than a shortfall:
   * the only thing that can release a parked payment is a signature over
   * `decisionId + intentHash` from a key this engine has registered, produced
   * wherever that private key lives. So the view carries the exact challenge
   * bytes and no affordance that would let the page assert a verdict.
   *
   * All-time, like reconciliation: the requests are durable now, so a resumed
   * console still shows the payment a human was asked about before the
   * restart — which is exactly when a forgotten escalation would bite, since
   * the breaker that stopped it resumed tripped.
   */
  function viewEscalation(r: ApprovalRequest, now: number): EscalationView {
    const pending = r.status === 'pending';
    return {
      decisionId: r.decisionId,
      intentId: r.intentId,
      intentHash: r.intentHash,
      agentId: r.agentId,
      agentName: agentName(r.agentId) ?? r.agentId,
      host: r.vendorHost,
      resource: r.resource,
      amount: r.amount,
      reason: r.reason,
      breakers: r.breakers,
      status: r.status,
      createdAt: r.createdAt.toISOString(),
      expiresAt: r.expiresAt.toISOString(),
      expiresInMs: r.expiresAt.getTime() - now,
      ...(r.resolvedAt ? { resolvedAt: r.resolvedAt.toISOString() } : {}),
      ...(r.approverKeyId
        ? { approverName: approvals.listApprovers().find((k) => k.id === r.approverKeyId)?.name ?? r.approverKeyId }
        : {}),
      ...(r.finalDecisionId !== undefined ? { finalDecisionId: r.finalDecisionId } : {}),
      // Only while answerable: bytes for a resolved request would invite
      // someone to sign something that can no longer be submitted.
      ...(pending ? { challenge: approvals.challengesFor(r) } : {}),
    };
  }

  function viewEscalations(now = Date.now()): EscalationsView {
    const all = approvals.list();
    return {
      approvers: approvals
        .listApprovers()
        .filter((k) => k.revokedAt === undefined)
        .map((k) => ({ id: k.id, name: k.name })),
      ttlMs: ESCALATION_TTL_MS,
      // Oldest first: the one closest to denying itself is the one that needs
      // answering, and it is the one a human has already waited longest on.
      pending: all
        .filter((r) => r.status === 'pending' && r.expiresAt.getTime() > now)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .map((r) => viewEscalation(r, now)),
      recent: all
        .filter((r) => r.status !== 'pending')
        .sort((a, b) => (b.resolvedAt?.getTime() ?? 0) - (a.resolvedAt?.getTime() ?? 0))
        .slice(0, ESCALATION_HISTORY)
        .map((r) => viewEscalation(r, now)),
      at: new Date(now).toISOString(),
    };
  }

  /**
   * The alert half of B1. Every other panel is driven by something happening;
   * this one is driven by something NOT happening, so it needs a clock. The
   * sweep re-measures the gaps and announces each allowance the first time it
   * crosses out of grace — once per intent, never a repeating alarm about a
   * payment an operator has already been told about.
   */
  const announcedGaps = new Map<string, number>();

  function sweepReconciliation(): void {
    const now = Date.now();
    const view = viewReconciliation(now);
    // Drop announcements for allowances that have aged out of the window. They
    // can never come back into it, so this is pure accretion otherwise — the
    // S28 lesson, on a Map that a long-lived console would grow forever.
    const windowFrom = Date.parse(view.at) - parseWindowMs(RECONCILE_WINDOW);
    for (const [intentId, allowedAt] of announcedGaps) {
      if (allowedAt < windowFrom) announcedGaps.delete(intentId);
    }
    for (const gap of view.gaps) {
      if (gap.state !== 'unsettled' || announcedGaps.has(gap.intentId)) continue;
      announcedGaps.set(gap.intentId, Date.parse(gap.allowedAt));
      pushFeed({
        seq: ++seq,
        at: new Date(now).toISOString(),
        kind: 'unsettled',
        agentId: gap.agentId,
        agentName: gap.agentName,
        amount: gap.amount,
        host: gap.host,
        resource: gap.resource,
        intentId: gap.intentId,
        ...(gap.decisionId !== undefined ? { decisionId: gap.decisionId } : {}),
      });
    }
    emit({ type: 'reconciliation', reconciliation: view });
  }

  /**
   * The alert half of B2, and the console's alert CHANNEL.
   *
   * `engine.sweepLiveness` raises each newly-missing agent exactly once and
   * emits the event; this turns that into a feed row and re-renders the agent
   * cards, which is what the console has instead of Telegram. Like the
   * reconciliation sweep it exists because nothing else will ever call: an
   * agent that stopped raises no intent to trigger a render.
   */
  async function sweepLiveness(): Promise<void> {
    const raised = await engine.sweepLiveness();
    for (const alert of raised) {
      pushFeed({
        seq: ++seq,
        at: new Date(alert.at).toISOString(),
        kind: 'missing',
        agentId: alert.agentId,
        agentName: agentName(alert.agentId) ?? alert.agentId,
        silentMs: alert.silentMs,
        interval: alert.expectation.interval,
        ...(alert.expectation.note !== undefined ? { reason: alert.expectation.note } : {}),
      });
    }
    // Even with nothing raised, the cards age: `alive` becomes `late` with no
    // event behind it, so the render has to be driven by the clock too.
    emit({ type: 'agents', agents: viewAgents() });
  }

  function computeStats(): Stats {
    // All-time counters read the DURABLE audit chain, not the feed. The feed is
    // this process's telemetry, so deriving decision counts from it made a
    // resumed world report 0 decisions beside 11 chain links — the same
    // number, from the same events, disagreeing with itself. One source.
    const chain = engine.decisions();
    const outcomes = (o: Decision['outcome']) => chain.filter((d) => d.outcome === o).length;
    // Since-boot counters stay on the feed: these have no durable reading to
    // restore (see Stats). Latency is this process's calls by definition.
    const decisionItems = feed.filter((f) => f.kind === 'decision');
    const settled = feed.filter((f) => f.kind === 'settled');
    const shadow = feed.filter((f) => f.kind === 'shadow');
    const latencies = decisionItems
      .map((d) => d.latencyMs)
      .filter((n): n is number => typeof n === 'number');
    const avg = latencies.length ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0;
    const gateStats = gate.stats();
    return {
      decisions: chain.length,
      allow: outcomes('allow'),
      deny: outcomes('deny'),
      escalate: outcomes('escalate'),
      agents: engine.agents.list().length,
      chainLinks: chain.length,
      revenue: sumDecimal(Object.values(gateStats.revenue)),
      quoted: gateStats.quoted,
      gateRefused: gateStats.refused,

      settled: settled.length,
      settledValue: sumDecimal(settled.map((s) => s.amount ?? '0')),
      shadow: shadow.length,
      shadowValue: sumDecimal(shadow.map((s) => s.amount ?? '0')),
      avgLatencyMs: Math.round(avg * 1000) / 1000,
      sigReleased: feed.filter((f) => f.kind === 'signature').length,
      sigRefused: feed.filter((f) => f.kind === 'sig-refused').length,
    };
  }

  // ── event wiring ───────────────────────────────────────────────────────────
  engine.onEvent((ev) => {
    if (ev.type === 'intent.created') {
      intents.set(ev.intent.id, ev.intent);
      intentIdOfNonce.set(intentNonce(ev.intent.id).toLowerCase(), ev.intent.id);
      return;
    }
    if (ev.type === 'liveness.recovered') {
      // The all-clear, and only for a silence somebody was told about — the
      // engine reports no recovery for an alarm it never raised.
      pushFeed({
        seq: ++seq,
        at: ev.at.toISOString(),
        kind: 'recovered',
        agentId: ev.agentId,
        agentName: agentName(ev.agentId) ?? ev.agentId,
        silentMs: ev.silentMs,
      });
      return;
    }
    if (ev.type === 'decision.made') {
      const d: Decision = ev.decision;
      const intent = intents.get(d.intentId);
      const agentId = intent?.agentId;
      if (d.outcome === 'allow' && intent && agentId) {
        const list = spend.get(agentId) ?? [];
        list.push(intent.amount);
        spend.set(agentId, list);
      }
      pushFeed({
        seq: ++seq,
        at: d.decidedAt.toISOString(),
        kind: 'decision',
        agentId,
        agentName: agentName(agentId),
        amount: intent?.amount,
        host: intent?.vendor.host,
        resource: intent?.resource,
        intentId: d.intentId,
        outcome: d.outcome,
        reason: d.reason,
        matchedRules: d.matchedRules,
        policyId: d.policyId,
        latencyMs: d.latencyMs,
        decisionId: d.id,
        hash: d.hash,
        prevHash: d.prevHash,
      });
    }
  });

  indexer.onEvent((ev) => {
    if (ev.type === 'payment.settled') {
      const intent = intents.get(ev.payment.intentId);
      // Close the reconciliation gap (B1). The indexer is the STRONG reporter
      // here — it read the ledger, rather than taking a payer's word for it —
      // so the world tells the engine even though every guard also self-reports;
      // the store keeps the first report and the two agree.
      reportSettlement({
        intentId: ev.payment.intentId,
        txHash: ev.payment.txHash,
        chain: ev.payment.chain,
        ...(intent ? { amount: intent.amount } : {}),
        source: 'indexer',
        confirmedAt: ev.payment.confirmedAt,
      });
      pushFeed({
        seq: ++seq,
        at: ev.payment.confirmedAt.toISOString(),
        kind: 'settled',
        agentId: intent?.agentId,
        agentName: agentName(intent?.agentId),
        amount: intent?.amount,
        host: intent?.vendor.host,
        intentId: ev.payment.intentId,
        txHash: ev.payment.txHash,
        chain: ev.payment.chain,
        blockNumber: ev.payment.blockNumber.toString(),
      });
    } else if (ev.type === 'shadow.spend') {
      pushFeed({
        seq: ++seq,
        at: ev.at.toISOString(),
        kind: 'shadow',
        agentId: ev.agentId,
        agentName: agentName(ev.agentId),
        amount: ev.amount,
        txHash: ev.txHash,
        chain: ev.chain,
      });
    }
  });

  gate.onEvent((ev) => {
    if (ev.type === 'gate.quoted') {
      pushFeed({
        seq: ++seq,
        at: ev.at.toISOString(),
        kind: 'quote',
        amount: ev.amount,
        host: VENDOR_HOST,
        resource: ev.resource,
        method: ev.method,
      });
    } else if (ev.type === 'gate.settled') {
      const r = ev.receipt;
      const payerAgent = agentByWallet(r.payer);
      pushFeed({
        seq: ++seq,
        at: ev.at.toISOString(),
        kind: 'revenue',
        agentId: payerAgent?.id,
        agentName: payerAgent?.name,
        amount: r.amount,
        host: VENDOR_HOST,
        resource: r.resource,
        route: r.route,
        payer: r.payer,
        txHash: r.transaction,
      });
    } else if (ev.type === 'gate.refused') {
      const payerAgent = agentByWallet(ev.payer);
      pushFeed({
        seq: ++seq,
        at: ev.at.toISOString(),
        kind: 'gate-refused',
        agentId: payerAgent?.id,
        agentName: payerAgent?.name,
        amount: quotedAmount(ev.resource),
        host: VENDOR_HOST,
        resource: ev.resource,
        payer: ev.payer,
        code: ev.code,
        reason: ev.reason,
      });
    }
    emit({ type: 'gate', gate: viewGate() });
  });

  signer.onEvent((ev) => {
    if (ev.type === 'signature.released') {
      sessionBurns.set(ev.sessionId, (sessionBurns.get(ev.sessionId) ?? 0) + 1);
      pushFeed({
        seq: ++seq,
        at: ev.at.toISOString(),
        kind: 'signature',
        agentId: ev.agentId,
        agentName: agentName(ev.agentId),
        amount: ev.amount,
        intentId: ev.intentId,
        decisionId: ev.decisionId,
        sessionId: ev.sessionId,
      });
    } else if (ev.type === 'signature.refused') {
      pushFeed({
        seq: ++seq,
        at: ev.at.toISOString(),
        kind: 'sig-refused',
        agentId: ev.agentId,
        agentName: agentName(ev.agentId),
        intentId: ev.intentId,
        sessionId: ev.sessionId,
        code: ev.code,
        reason: ev.reason,
      });
    }
    emit({ type: 'signer', signer: viewSigner() });
  });

  // ── reputation wiring ──────────────────────────────────────────────────────
  // The graph ingests every bus. Engine-side subjects (agent ULIDs, vendor
  // hosts) and gate-side subjects (payer wallets, payTo addresses) are disjoint
  // id spaces, so feeding one graph from all four buses never double-counts.
  graph.observe(engine).observe(indexer).observe(gate).observe(signer);

  // Identity linking (the ERC-8004 story): link facts come from the Identity
  // Registry — here the in-memory twin standing in for the real contract, like
  // the mock ledger stands in for the chain. Links are derived state: the
  // registry is rebuilt each boot from the persisted agent docs (their
  // erc8004Ids name the tokenIds) and every link is re-asserted (idempotent),
  // never persisted. Registered agents are ERC-8004-CANONICAL — one on-chain
  // identity, one reputation row — while vendors stay host-canonical (hosts
  // are the enforcement key syncVendors pushes into the engine).
  const registry = new MockIdentityRegistry();
  /** The parsed ref, but only when it names OUR registry (foreign ids are not ours to resolve). */
  const ownRegistryRef = (erc8004Id: string | undefined) => {
    const ref = erc8004Id === undefined ? undefined : parseErc8004Id(erc8004Id);
    return ref !== undefined &&
      ref.chainId === registry.ref.chainId &&
      ref.registry === registry.ref.address.toLowerCase()
      ? ref
      : undefined;
  };
  // Hydrate ALL known registrations before any register() — minted tokenIds
  // must never collide with resumed ones. wallets[0] is the current key.
  for (const agent of engine.agents.list()) {
    const ref = ownRegistryRef(agent.erc8004Id);
    const wallet = agent.wallets[0]?.address;
    if (ref && wallet !== undefined) {
      registry.load({ tokenId: ref.tokenId, owner: wallet, agentWallet: wallet });
    }
  }
  async function linkAgentIdentity(agent: Agent): Promise<void> {
    // MUST be awaited by callers: the registry reads are async, and evidence
    // arriving before the alias map is populated mints a stray row (S15 rule).
    await linkAgentFromRegistry(graph, registry, agent);
  }
  // The world vendor's identity: registered fresh each boot (the mock chain is
  // derived state too); its agentWallet IS the treasury, so the payTo alias
  // now comes from registry facts instead of a hardcoded link. tokenId churn
  // across boots is harmless — vendor erc8004 ids are aliases only, and an
  // alias never accrues evidence of its own.
  const vendorIdentity = registry.register({ owner: TREASURY });
  await linkVendorFromRegistry(graph, registry, {
    host: VENDOR_HOST,
    erc8004Id: vendorIdentity.erc8004Id,
  });
  for (const agent of engine.agents.list()) await linkAgentIdentity(agent); // resumed agents

  // Backfill breakers onto policies a durable store wrote BEFORE A3 existed.
  // `addAgentPolicy` only ever runs for a NEW agent, so without this the
  // breaker panel would be permanently empty on exactly the deployment that
  // has state worth looking at (app.reinconsole.com has a volume). addPolicy
  // upserts by policyId, so this is idempotent and needs no migration table.
  for (const p of engine.policies.list()) {
    if (p.breakers.length === 0) await engine.addPolicy({ ...p, breakers: [...AGENT_BREAKERS] });
  }

  /**
   * Register the operator's approver key, if this deployment has one.
   *
   * Env-gated and PUBLIC-key only, which is the whole posture: the console
   * never holds anything that could sign, so the worst an attacker gets from
   * it is the ability to show someone a challenge. A deployment with no key
   * set is the honest default — a parked payment there is one nobody can
   * release, and the panel says exactly that rather than implying a human is
   * being asked. Re-registering the same PEM every boot would mint a second
   * key id, so an existing key with this material is left alone.
   */
  async function wireApprover(): Promise<void> {
    // A PEM in an env var usually arrives with its newlines escaped; a key
    // that silently failed to parse would read as "nobody can approve", which
    // is the one wrong answer this panel must never give by accident.
    const pem = process.env['REIN_APPROVER_PUBLIC_KEY']?.trim().replace(/\\n/g, '\n');
    if (!pem) return;
    if (approvals.listApprovers().some((k) => k.publicKey === pem && k.revokedAt === undefined)) {
      return;
    }
    try {
      const key = await approvals.registerApprover({
        orgId: WORLD_ORG,
        name: process.env['REIN_APPROVER_NAME']?.trim() || 'operator',
        publicKey: pem,
      });
      console.log(`[rein] approver key registered: ${key.name} (${key.id})`);
    } catch (err) {
      // A malformed key must be loud and must not take the console down: the
      // dashboard still tells the truth, which is that nobody can approve.
      console.error('[console] REIN_APPROVER_PUBLIC_KEY was not a usable ed25519 PEM:', err);
    }
  }
  await wireApprover();

  // Same story for the dead-man watches (B2): agents provisioned before B2
  // existed carry no expectation, so a resumed deployment would show liveness
  // on nobody. `watchLiveness` upserts and keeps the original `since`, so
  // re-running it every boot neither duplicates a watch nor hands a silent
  // agent a fresh clock.
  for (const agent of engine.agents.list()) {
    if (agent.labels.includes(LIVENESS_LABEL)) await watchAgentLiveness(agent.id);
  }

  /**
   * REAL-registry mode (env-gated): `REIN_CONSOLE_REGISTRY=sepolia` provisions
   * a "live identity" agent whose erc8004Id is the REAL Base Sepolia
   * registration (`REIN_SEPOLIA_ERC8004_ID`) — its link facts (ownerOf,
   * agentWallet) are read from the actual chain through the viem reader, a
   * drop-in for the same port the mock twin implements. READ-ONLY: the console
   * never writes on-chain (no gas, no keys) and world-generated agents stay on
   * the mock registry. If the RPC is unreachable the world still boots — a
   * resumed doc keeps the lenient local links the generic loop above already
   * asserted, and the miss is logged loudly (S17 rule: a dead RPC must never
   * read as "not registered").
   */
  async function wireLiveIdentity(): Promise<void> {
    if (process.env['REIN_CONSOLE_REGISTRY'] !== 'sepolia') return;
    const rawId = process.env['REIN_SEPOLIA_ERC8004_ID'];
    const ref = rawId === undefined ? undefined : parseErc8004Id(rawId);
    if (!ref) {
      console.error(
        `[console] REIN_CONSOLE_REGISTRY=sepolia needs a parseable REIN_SEPOLIA_ERC8004_ID (got ${rawId ?? 'nothing'}) — live identity skipped`,
      );
      return;
    }
    if (
      ref.chainId !== BASE_SEPOLIA_REGISTRY.chainId ||
      ref.registry !== BASE_SEPOLIA_REGISTRY.address.toLowerCase()
    ) {
      console.error(`[console] ${rawId} names a foreign registry — live identity skipped`);
      return;
    }
    const erc8004Id = formatErc8004Id(ref);
    try {
      const publicClient = createBaseSepoliaClient(process.env['REIN_SEPOLIA_RPC_URL']);
      const reader = identityRegistryReader(publicClient);
      const owner = await reader.ownerOf(ref.tokenId);

      let agent = engine.agents.list().find((a) => a.erc8004Id === erc8004Id);
      if (!agent) {
        const agentId = newId('agt');
        agent = await engine.registerAgent({
          id: agentId,
          orgId: WORLD_ORG,
          name: `sepolia-agent-${ref.tokenId}`,
          erc8004Id,
          labels: ['sepolia'],
          wallets: [{ chain: 'base', address: owner, mode: 'sdk' }],
          status: 'active',
          createdAt: new Date(),
        });
        await engine.addPolicy({
          policyId: `policy-sepolia-agent-${ref.tokenId}`,
          appliesTo: { agents: [agentId] },
          rules: [
            { id: 'tx-cap', deny: { amountGt: TX_CAP } },
            { id: 'hour-budget', deny: { rollingSum: { window: '1h', gt: HOUR_BUDGET } } },
            { id: 'reputation-gate', deny: { vendorReputationLt: REP_FLOOR } },
          ],
          breakers: [...AGENT_BREAKERS],
          default: 'allow',
        });
      }
      // Link facts from the REAL chain (same port, real adapter). Idempotent:
      // a resumed boot's local links fold into the same canonical row.
      await linkAgentFromRegistry(graph, reader, agent);
      // Pingable like any SDK-tier agent (mock rails take any payer address —
      // the console's payments stay mock; only IDENTITY facts are live).
      if (!runtimes.has(agent.id)) {
        const guard = createGuard({
          engineUrl,
          agentId: agent.id,
          fetch: gatedFetch,
          payer: facilitator.payerFor(owner),
        });
        registerRuntime(agent.id, owner, guard.wrap());
      }
      const summary = await readSummary(publicClient, {
        agentId: ref.tokenId,
        tag1: REIN_SCORE_TAG,
      });
      console.log(
        `[rein] live identity ${erc8004Id}: owner ${owner}, on-chain ${REIN_SCORE_TAG} ` +
          (summary.count > 0n
            ? `${summary.value}/100 (${summary.count} entr${summary.count === 1n ? 'y' : 'ies'})`
            : '(none yet)'),
      );
    } catch (err) {
      console.error(
        '[console] live registry unreachable — the live identity keeps its local links this boot:',
        (err as Error).message,
      );
    }
  }

  /** Push confident vendor scores into the engine and broadcast the panel. */
  async function syncGraph(): Promise<void> {
    const pushed = await graph.syncVendors(engine.spend, { minConfidence: REP_MIN_CONFIDENCE });
    for (const p of pushed) syncedHosts.add(p.host);
    lastSyncAt = new Date().toISOString();
    emit({ type: 'graph', graph: viewGraph() });
  }

  // Sync is a snapshot push, not a subscription — re-push shortly after any
  // burst of new evidence so vendorReputationLt always sees current scores.
  function scheduleSync(): void {
    if (syncTimer) return;
    syncTimer = setTimeout(() => {
      syncTimer = undefined;
      // Breaker windows move with every recorded spend, so they ride the same
      // debounce rather than a subscription of their own. Pure read — unlike
      // syncGraph it pushes nothing INTO the engine, so it cannot fail.
      emit({ type: 'breakers', breakers: viewBreakers() });
      // Parked and resolved escalations ride the same debounce: both of the
      // events that change them (`approval.requested`, `approval.resolved`)
      // are engine events, and so is the decision each one carries.
      emit({ type: 'escalations', escalations: viewEscalations() });
      syncGraph().catch((err: unknown) =>
        console.error('[console] reputation sync failed:', err),
      );
    }, 250);
  }
  for (const bus of [engine, indexer, gate, signer]) bus.onEvent(() => scheduleSync());

  // ── imported reputation history ────────────────────────────────────────────
  // Live evidence is same-day and confidence-discounted, so a brand-new world
  // would have nothing enforceable. Seed the graph with two weeks of backdated
  // history — the receipts a deployment would have accumulated before this
  // console booted. The world's own vendor (api.data.test) is deliberately NOT
  // seeded: watch its confidence climb live as scenario runs accumulate.
  function seedReputationHistory(): void {
    const start = Date.now() - 14 * DAY_MS;
    const historian = newId('agt'); // the fictional pre-console agent on those receipts
    const receipt = (host: string, at: Date, settled: boolean): Receipt => ({
      id: newId('rcp'),
      agentId: historian,
      intentId: newId('int'),
      decisionId: newId('dec'),
      outcome: 'allow',
      url: `https://${host}/v1/query`,
      method: 'GET',
      vendorHost: host,
      amount: '0.05',
      asset: 'USDC',
      chain: 'base',
      taskContext: {},
      settlement: settled ? { txHash: `0x5eed${at.getTime().toString(16)}` } : undefined,
      createdAt: at,
    });
    for (let i = 0; i < 15; i += 1) {
      const at = new Date(start + i * 22 * HOUR_MS);
      graph.ingestReceipt(receipt(GOOD_VENDOR, at, true)); // 15/15 settled
      graph.ingestReceipt(receipt(SKETCHY_VENDOR, at, i < 2)); // 2/15 settled
    }
    for (let i = 0; i < 3; i += 1) {
      graph.report({
        subject: { kind: 'vendor', id: SKETCHY_VENDOR },
        kind: 'dispute',
        at: new Date(start + (4 + i * 3) * DAY_MS),
        note: 'chargeback reported out-of-band',
      });
    }
    // The offender: one payment replayed 12 times at OTHER vendors' gates.
    for (let i = 0; i < 12; i += 1) {
      graph.ingest({
        type: 'gate.refused',
        at: new Date(start + i * 12 * HOUR_MS),
        code: 'payment_replayed',
        reason: 'replay of an already-settled payment',
        resource: 'https://other-vendor.example/api/answer',
        payer: OFFENDER_WALLET,
      });
    }
  }

  // ── agent provisioning ───────────────────────────────────────────────────
  // Engine writes are AWAITED: on a persistent store they land on disk before
  // the working set reflects them, and the very next scenario beat evaluates
  // against this agent — an unawaited write would race it. (In-memory stores
  // resolve immediately, so the await costs nothing there.)
  async function addAgentPolicy(
    name: string,
    agentId: string,
    wallet: { address: string; mode: 'sdk' | 'session-key' },
    // The envelope this agent's role carries. Defaults to the loose one every
    // established agent gets; the probation agent passes its own.
    breakers: readonly { id: string; window: string; txCount?: number; valueCap?: string }[] = AGENT_BREAKERS,
  ): Promise<void> {
    // Register on the (mock) Identity Registry FIRST — the doc carries the
    // erc8004Id, so every future boot can rebuild the registry from the store.
    const registration = registry.register({ owner: wallet.address });
    const agent = await engine.registerAgent({
      id: agentId,
      orgId: WORLD_ORG,
      name,
      erc8004Id: registration.erc8004Id,
      // The role slug ("research-agent-3" → "research") becomes a semantic
      // label — what policy appliesTo.labels targets instead of opaque ULIDs.
      labels: [name.replace(/-agent(-\d+)?$/, '')],
      wallets: [{ chain: 'base', address: wallet.address, mode: wallet.mode }],
      status: 'active',
      createdAt: new Date(),
    });
    // One party, one score: from the moment it exists, the agent's reputation
    // keys by its on-chain identity — ULID and wallet fold in as aliases.
    await linkAgentIdentity(agent);
    await engine.addPolicy({
      policyId: `policy-${name}`,
      appliesTo: { agents: [agentId] },
      rules: [
        { id: 'tx-cap', deny: { amountGt: TX_CAP } },
        { id: 'hour-budget', deny: { rollingSum: { window: '1h', gt: HOUR_BUDGET } } },
        // Fires only on a KNOWN bad score — the graph withholds low-confidence
        // scores at sync, so unknown vendors stay ungoverned by this rule.
        { id: 'reputation-gate', deny: { vendorReputationLt: REP_FLOOR } },
      ],
      breakers: breakers.map((b) => ({ ...b })),
      default: 'allow',
    });
    // Dead-man watch (B2), for the research pollers only — see LIVENESS_LABEL.
    if (agent.labels.includes(LIVENESS_LABEL)) await watchAgentLiveness(agentId);
    emit({ type: 'agents', agents: viewAgents() });
    emit({ type: 'policies', policies: viewPolicies() });
    emit({ type: 'breakers', breakers: viewBreakers() });
  }

  function watchAgentLiveness(agentId: string): Promise<unknown> {
    return engine.watchLiveness({
      agentId,
      interval: LIVENESS_INTERVAL,
      graceMs: LIVENESS_GRACE_MS,
      note: LIVENESS_NOTE,
    });
  }

  function registerRuntime(agentId: string, wallet: string, wrapped: FetchLike): FetchLike {
    runtimes.set(agentId, {
      wallet,
      ping: async () => {
        await wrapped(VENDOR_URL).catch(swallowGoverned);
      },
    });
    return wrapped;
  }

  /** SDK tier: the agent holds its own (mock) wallet key. */
  async function provisionAgent(
    name: string,
    options: { breakers?: readonly { id: string; window: string; txCount?: number; valueCap?: string }[] } = {},
  ): Promise<{
    agentId: string;
    wallet: string;
    fetch: FetchLike;
    lastHeader: () => string;
  }> {
    const agentId = newId('agt');
    const wallet = `0x${name.replace(/[^a-z0-9]/gi, '')}Wallet`;
    await addAgentPolicy(
      name,
      agentId,
      { address: wallet, mode: 'sdk' },
      options.breakers ?? AGENT_BREAKERS,
    );
    // Capture raw X-PAYMENT headers — the replay scenario re-presents one.
    let captured = '';
    const inner = facilitator.payerFor(wallet);
    const payer: Payer = async (requirement, intent, decision) => {
      captured = await inner(requirement, intent, decision);
      return captured;
    };
    const guard = createGuard({ engineUrl, agentId, fetch: gatedFetch, payer });
    const wrapped = registerRuntime(agentId, wallet, guard.wrap());
    return { agentId, wallet, fetch: wrapped, lastHeader: () => captured };
  }

  /** Session-key tier: the wallet key never leaves the signer. */
  async function provisionSessionAgent(name: string): Promise<{
    agentId: string;
    wallet: string;
    fetch: FetchLike;
    sessionToken: string;
    lastSignRequest: () => SignRequest | undefined;
  }> {
    const agentId = newId('agt');
    const wallet = signer.registerWallet(agentId, generatePrivateKey());
    await addAgentPolicy(name, agentId, { address: wallet, mode: 'session-key' });
    const { token } = await signer.createSession({
      agentId,
      capAmount: SESSION_CAP,
      ttlSeconds: 24 * 3600,
    });
    emit({ type: 'signer', signer: viewSigner() });
    // Capture the voucher the guard hands the signer — the stolen-voucher
    // scenario replays it. Captured BEFORE signing: the decision burns on use.
    let captured: SignRequest | undefined;
    const inner = sessionPayerFor(signer, token);
    const payer: Payer = (requirement, intent, decision) => {
      captured = { sessionToken: token, requirement, intent, decision };
      return inner(requirement, intent, decision);
    };
    const guard = createGuard({ engineUrl, agentId, fetch: gatedFetch, payer });
    const wrapped = registerRuntime(agentId, wallet, guard.wrap());
    return { agentId, wallet, fetch: wrapped, sessionToken: token, lastSignRequest: () => captured };
  }

  /**
   * Rebuild a pingable runtime for an agent RESUMED from the store. SDK-tier
   * runtimes rebuild directly from the persisted wallet address. Session-tier
   * runtimes need secrets a restart loses on purpose — the custodied private
   * key and the bearer token are never persisted — so the agent's key is
   * ROTATED: a fresh key into the signer's custody, the agent doc re-registered
   * under the new address, and a fresh capped session minted. Identity linking
   * folds the new wallet into the agent's existing reputation (the old
   * wallet's evidence was durably merged when it was linked), so one party
   * keeps one score across the rotation.
   */
  async function rebuildRuntime(agent: Agent): Promise<void> {
    if (runtimes.has(agent.id)) return;
    const wallet = agent.wallets[0];
    if (!wallet) return;
    if (wallet.mode === 'session-key') {
      const address = signer.registerWallet(agent.id, generatePrivateKey());
      // The new wallet goes FIRST (wallets[0] = current); the old ones stay in
      // the doc so every future boot's re-link still knows them — evidence that
      // arrives against a retired wallet (e.g. a replayed pre-kill payment
      // header refused at the gate) must keep folding into THIS agent, not
      // mint a stray unlinked scoreboard row.
      const rotated = await engine.registerAgent({
        ...agent,
        wallets: [{ chain: 'base', address, mode: 'session-key' }, ...agent.wallets],
      });
      // The registry follows the rotation: the on-chain identity's verified
      // payment wallet becomes the fresh key. Safe unconditionally — every
      // own-registry doc with a wallet was load()ed before rebuildRuntime runs.
      const ref = ownRegistryRef(rotated.erc8004Id);
      if (ref) registry.setAgentWallet(ref.tokenId, address);
      await linkAgentIdentity(rotated);
      // The previous boot's grant died with its token — revoke it (durably)
      // rather than leave spent authority dangling until TTL, then DROP the
      // record: a dead grant whose key was never persisted is pure accretion
      // (one per boot — the S28 finding), and deleting fails closed. This
      // also drains records accreted by boots that predate the delete.
      for (const stale of signer.sessions()) {
        if (stale.agentId !== agent.id) continue;
        if (stale.revokedAt === undefined) await signer.revokeSession(stale.id);
        await signer.deleteSession(stale.id);
      }
      const { token } = await signer.createSession({
        agentId: agent.id,
        capAmount: SESSION_CAP,
        ttlSeconds: 24 * 3600,
      });
      const payer = sessionPayerFor(signer, token);
      const guard = createGuard({ engineUrl, agentId: agent.id, fetch: gatedFetch, payer });
      registerRuntime(agent.id, address, guard.wrap());
    } else {
      const payer: Payer = facilitator.payerFor(wallet.address);
      const guard = createGuard({ engineUrl, agentId: agent.id, fetch: gatedFetch, payer });
      registerRuntime(agent.id, wallet.address, guard.wrap());
    }
  }

  // ── scripted scenario ──────────────────────────────────────────────────────
  async function playScenario(paced: boolean): Promise<void> {
    const gap = paced ? 650 : 0;
    const setPhase = (phase: string) => {
      demo = { running: true, phase };
      emit({ type: 'demo', demo });
    };

    demoRuns += 1;
    const name = `research-agent-${demoRuns}`;
    setPhase(`spinning up ${name}`);
    const sdk = await provisionAgent(name);
    await sleep(gap);

    // 1 — four allowed, paid calls within the rolling budget (quote → allow →
    //     vendor revenue → on-chain settle, all visible per call)
    setPhase('normal calls within budget');
    for (let i = 0; i < 4; i++) {
      await sdk.fetch(VENDOR_URL);
      await sleep(gap);
    }

    // 2 — the fifth call trips the rolling-budget cap (deny before payment)
    setPhase('rolling-budget cap');
    await sdk.fetch(VENDOR_URL).catch(swallowGoverned);
    await sleep(gap);

    // 3 — the $5.00 premium route trips the per-transaction cap
    setPhase('single-transaction cap');
    await sdk.fetch(PREMIUM_URL).catch(swallowGoverned);
    await sleep(gap);

    // 4 — a direct transfer that bypasses the guard entirely → shadow spend
    setPhase('shadow spend (bypass)');
    ledger.transfer({ chain: 'base', asset: 'USDC', from: sdk.wallet, to: '0xDeadVendor', amount: '2.50' });
    await sleep(gap);

    // 5 — an unpaid crawler probes the API and gets a quote, not a handout
    setPhase('unpaid crawler gets quoted');
    await gatedFetch(VENDOR_URL);
    await sleep(gap);

    // 6 — the same settled payment, presented again → replay burned
    setPhase('replayed payment refused');
    await gatedFetch(VENDOR_URL, { headers: { 'X-PAYMENT': sdk.lastHeader() } });
    await sleep(gap);

    // 7 — a denylisted mule pays the exact right amount → screening refuses
    setPhase('denylisted payer refused');
    await gatedFetch(VENDOR_URL, {
      headers: { 'X-PAYMENT': craftPayment(MULE_WALLET, PRICE_ATOMIC) },
    });
    await sleep(gap);

    // 8 — the custody tier: a session-key agent, wallet held by the signer
    const sessionName = `session-agent-${demoRuns}`;
    setPhase(`spinning up ${sessionName} (key in custody)`);
    const session = await provisionSessionAgent(sessionName);
    await sleep(gap);

    // 9 — two voucher-gated EIP-3009 purchases (signature.released each time)
    setPhase('session-key purchases');
    await session.fetch(VENDOR_URL);
    await sleep(gap);
    await session.fetch(VENDOR_URL);
    await sleep(gap);

    // 10 — a stolen voucher replayed straight at the signer → decision burned
    setPhase('stolen voucher replayed');
    const voucher = session.lastSignRequest();
    if (voucher) await signer.sign(voucher).then(() => undefined, swallowGoverned);
    await sleep(gap);

    // 11 — the engine allows a third $0.01, but the session cap says no:
    //      defense in depth — the key itself is the last line
    setPhase('session cap backstop');
    await session.fetch(VENDOR_URL).catch(swallowGoverned);
    await sleep(gap);

    // 12 — reputation closes the loop on the engine: a fresh agent probes a
    //      vendor the network already burned — denied before any payment exists
    setPhase(`reputation check: ${SKETCHY_VENDOR}`);
    const proc = await provisionAgent(`procurement-agent-${demoRuns}`);
    await proc.fetch(`https://${SKETCHY_VENDOR}/v1/query`).catch(swallowGoverned);
    await sleep(gap);

    // 13 — same agent, same policy, same price, reputable vendor: business as usual
    setPhase(`reputation check: ${GOOD_VENDOR}`);
    await proc.fetch(`https://${GOOD_VENDOR}/v1/query`);
    await sleep(gap);

    // 14 — the offender wallet presents a fresh, valid payment; it never
    //      wronged THIS vendor, but evidence from other gates bars the door
    setPhase('low-reputation payer at the door');
    await gatedFetch(VENDOR_URL, {
      headers: { 'X-PAYMENT': craftPayment(OFFENDER_WALLET, PRICE_ATOMIC) },
    });
    await sleep(gap);

    // 15 — a burst buyer offers a valid $5.00 payment for the premium report;
    //      the gate's per-payer spend velocity cap refuses at the door —
    //      before the replay burn, and (fairness skip-set) with NO reputation
    //      evidence: one vendor's throttle must not follow the wallet around
    setPhase('velocity cap at the door');
    await gatedFetch(PREMIUM_URL, {
      headers: { 'X-PAYMENT': craftPayment(BURST_WALLET, PREMIUM_PRICE_ATOMIC) },
    });
    await sleep(gap);

    // 16 — the human-in-the-loop tier (A2/A3): a new hire on a probationary
    //      envelope of two purchases an hour. Two go through; the third is
    //      PARKED, not denied — a breaker escalates, it never refuses on its
    //      own authority. Nothing on this console can release it: an approval
    //      is a signature over decisionId+intentHash from a key held wherever
    //      the human is, and a dashboard button that stood in for one would be
    //      the click-to-approve path A2 exists to refuse.
    const probationName = `probation-agent-${demoRuns}`;
    setPhase(`spinning up ${probationName} (probationary envelope)`);
    const probation = await provisionAgent(probationName, { breakers: PROBATION_BREAKERS });
    await sleep(gap);

    setPhase('probationary purchases');
    await probation.fetch(VENDOR_URL);
    await sleep(gap);
    await probation.fetch(VENDOR_URL);
    await sleep(gap);

    // 17 — the third purchase leaves the envelope, so a human is asked
    setPhase('breaker trips: payment parked for a signature');
    await probation.fetch(VENDOR_URL).catch(swallowGoverned);
    await sleep(gap);

    demo = { running: false, phase: 'idle' };
    emit({ type: 'demo', demo });
  }

  // ── public API ─────────────────────────────────────────────────────────────
  async function submitGrant(grant: {
    decisionId: string;
    intentHash: string;
    verdict: 'approve' | 'reject';
    approverKeyId: string;
    signature: string;
  }): Promise<{ status: string; finalDecisionId: string }> {
    const { request, decision } = await engine.resolveEscalation(grant);
    emit({ type: 'escalations', escalations: viewEscalations() });
    return { status: request.status, finalDecisionId: decision.id };
  }

  function runDemo(): boolean {
    if (demo.running) return false;
    demo = { running: true, phase: 'starting' };
    emit({ type: 'demo', demo });
    void playScenario(true).catch((err) => {
      console.error('[console] demo run failed:', err);
      demo = { running: false, phase: 'idle' };
      emit({ type: 'demo', demo });
    });
    return true;
  }

  async function freeze(agentId: string): Promise<boolean> {
    if (!engine.agents.list().some((a) => a.id === agentId)) return false;
    await engine.freeze(agentId); // durable stores persist BEFORE the registry reflects it
    emit({ type: 'agents', agents: viewAgents() });
    emit({ type: 'stats', stats: computeStats() });
    return true;
  }

  async function unfreeze(agentId: string): Promise<boolean> {
    if (!engine.agents.list().some((a) => a.id === agentId)) return false;
    await engine.unfreeze(agentId);
    emit({ type: 'agents', agents: viewAgents() });
    emit({ type: 'stats', stats: computeStats() });
    return true;
  }

  async function pingAgent(agentId: string): Promise<boolean> {
    const rt = runtimes.get(agentId);
    if (!rt) return false;
    await rt.ping();
    return true;
  }

  function getState(): ConsoleState {
    return {
      feed: [...feed],
      agents: viewAgents(),
      policies: viewPolicies(),
      stats: computeStats(),
      gate: viewGate(),
      signer: viewSigner(),
      graph: viewGraph(),
      breakers: viewBreakers(),
      reconciliation: viewReconciliation(),
      escalations: viewEscalations(),
      demo,
      publicKey: engine.publicKeyPem,
      startedAt,
    };
  }

  function subscribe(listener: (ev: ServerEvent) => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  // Durable-store maintenance (S19): flush() is the write-behind error
  // channel — if it only ran at close(), a mid-run disk failure would stay
  // invisible until shutdown. Drain gate + graph tails every 30s (surfacing
  // the first failure in the logs within seconds of it happening) and TTL-
  // prune the burn tables so a long-lived console doesn't accrete them.
  // The reconciliation clock (B1) — see sweepReconciliation. Unref'd, so it
  // never holds a process open, and stopped in close().
  const reconcileTimer: NodeJS.Timeout = setInterval(sweepReconciliation, RECONCILE_SWEEP_MS);
  reconcileTimer.unref?.();

  // The dead-man clock (B2) — the same reason as the reconciliation one, for
  // the same kind of event: something that has to AGE into existence.
  const livenessTimer: NodeJS.Timeout = setInterval(() => {
    void sweepLiveness().catch((err: unknown) =>
      console.error('[console] liveness sweep failed:', err),
    );
  }, LIVENESS_SWEEP_MS);
  livenessTimer.unref?.();

  // The escalation clock (A2). Correctness does not depend on it — a lapsed
  // request refuses every signature on its own — but the DENY it owes the
  // audit chain only lands when something runs, and a payment whose refusal
  // never reached the chain is a hole in the record of what this engine did.
  const stopExpirySweeper = engine.startExpirySweeper();

  let maintenanceTimer: NodeJS.Timeout | undefined;
  if (store) {
    maintenanceTimer = setInterval(() => {
      void (async () => {
        try {
          await gate.flush();
          await graph.flush();
          await store.prune();
        } catch (err) {
          console.error('[console] store maintenance failed (telemetry may be lagging):', err);
        }
      })();
    }, 30_000);
    maintenanceTimer.unref?.();
  }

  async function close(): Promise<void> {
    if (syncTimer) clearTimeout(syncTimer);
    if (maintenanceTimer) clearInterval(maintenanceTimer);
    clearInterval(reconcileTimer);
    clearInterval(livenessTimer);
    stopExpirySweeper();
    await app.close();
    // Flush write-behind reputation evidence before the handle goes away. A
    // failure here means some evidence was NOT persisted — log it loudly, but
    // don't take the dev-server teardown down with it.
    if (store) {
      await store.close().catch((err: unknown) => {
        console.error('[console] store close failed (unflushed evidence may be lost):', err);
      });
    }
  }

  // Seed an initial story so the console is alive on first load — but only on
  // a FRESH store. A resumed world already carries its history (re-seeding
  // would double-count the imported evidence), so it boots straight onto the
  // resumed state; the feed starts empty because it is telemetry, not state.
  // Reputation history lands first and is synced into the engine BEFORE the
  // scenario, so the reputation-gate beats evaluate against current scores.
  const fresh = store?.fresh ?? true;
  if (fresh) seedReputationHistory();
  // Resumed agents get live runtimes again (no-op on a fresh world — the
  // scenario provisions its own). Session-tier keys rotate here, BEFORE the
  // first sync, so the scoreboard's first frame already shows merged identities.
  for (const agent of engine.agents.list()) await rebuildRuntime(agent);
  // Env-gated: the live Base Sepolia identity joins the world (read-only).
  await wireLiveIdentity();
  await syncGraph();
  if (fresh) await playScenario(false);
  // Every settlement the scenario produced is written before the world is
  // handed over, so the first snapshot's reconciliation is the real one.
  await settlementTail;
  if (store) {
    console.log(
      `[rein] console world on ${options.dataDir}: ` +
        (fresh
          ? 'fresh store (seeded)'
          : `resumed ${store.resumedDecisions} decisions, ${store.resumedSubjects} reputation subjects, ` +
            `${engine.agents.list().length} agents, ${store.resumedSessions} signer sessions, ` +
            `${store.resumedReceipts} gate receipts`),
    );
  }

  return { getState, subscribe, freeze, unfreeze, pingAgent, submitGrant, runDemo, close };
}
