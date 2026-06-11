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
import { newId, sumDecimal, type Agent, type Decision, type PaymentIntent } from '@rein/core';
import { PolicyEngine, buildServer } from '@rein/policy-engine';
import {
  createGuard,
  PaymentBlockedError,
  atomicToDecimal,
  networkToChain,
  requirementDecimals,
  resolveAsset,
  type FetchLike,
  type Payer,
  type PaymentRequirement,
} from '@rein/sdk';
import { MockLedger, MockFacilitator, MockIndexer } from '@rein/mock-rails';
import {
  createGate,
  createGatedFetch,
  mockFacilitatorRails,
  GateError,
  type GateRails,
} from '@rein/gate';
import { SessionSigner, sessionPayerFor, SignerError, type SignRequest } from '@rein/signer';
import {
  chainIdForNetwork,
  encodeSettlementHeader,
  intentNonce,
  transferWithAuthorizationTypes,
  PaymentPayload,
} from '@rein/x402-rails';
import type {
  AgentView,
  ConsoleState,
  DemoStatus,
  FeedItem,
  GateView,
  PolicyView,
  PolicyRuleView,
  ServerEvent,
  Stats,
} from './wire';

const VENDOR_HOST = 'api.data.test';
const VENDOR_URL = `https://${VENDOR_HOST}/v1/query`;
const PREMIUM_URL = `https://${VENDOR_HOST}/v1/premium`;
const PRICE = '0.01';
const PREMIUM_PRICE = '5.00';
const PRICE_ATOMIC = '10000'; // $0.01 USDC (6 decimals)
/** USDC on Base — built into the SDK's asset resolution, and a real EIP-712
 * verifying contract for the session-key lane (lowercased: no checksum trips). */
const USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
/** Real-hex addresses: the EIP-3009 lane signs typed data over them. */
const TREASURY = '0x7e57000000000000000000000000000000000001';
const MULE_WALLET = '0xbad0000000000000000000000000000000000666';
const TX_CAP = '0.50';
const HOUR_BUDGET = '0.04';
const SESSION_CAP = '0.02';
const FEED_CAP = 300;

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

interface AgentRuntime {
  wallet: string;
  /** A guard-wrapped fetch bound to this agent against the gated vendor. */
  ping: () => Promise<void>;
}

export interface World {
  getState(): ConsoleState;
  subscribe(listener: (ev: ServerEvent) => void): () => void;
  freeze(agentId: string): boolean;
  unfreeze(agentId: string): boolean;
  pingAgent(agentId: string): Promise<boolean>;
  runDemo(): boolean;
  close(): Promise<void>;
}

export async function createWorld(): Promise<World> {
  const engine = new PolicyEngine();
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
  const signer = new SessionSigner({ enginePublicKeyPem: engine.publicKeyPem });

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
    const decodeEvm = (header: string) => {
      try {
        const json: unknown = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
        const parsed = PaymentPayload.safeParse(json);
        return parsed.success ? parsed.data : undefined;
      } catch {
        return undefined;
      }
    };
    return {
      async verify(header, requirement) {
        const evm = decodeEvm(header);
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
        const evm = decodeEvm(header);
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
    screen: { denyPayers: [MULE_WALLET] },
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
  let demoRuns = 0;
  let demo: DemoStatus = { running: false, phase: 'idle' };

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

  function pushFeed(item: FeedItem): void {
    feed.push(item);
    if (feed.length > FEED_CAP) feed.shift();
    emit({ type: 'feed', item });
    emit({ type: 'agents', agents: viewAgents() });
    emit({ type: 'stats', stats: computeStats() });
  }

  function viewAgents(): AgentView[] {
    return engine.agents.list().map((a: Agent): AgentView => {
      const amounts = spend.get(a.id) ?? [];
      const wallet = a.wallets[0];
      return {
        id: a.id,
        name: a.name,
        status: engine.agents.isFrozen(a.id) ? 'frozen' : 'active',
        mode: wallet?.mode ?? 'observed',
        chain: wallet?.chain ?? '—',
        address: wallet?.address ?? '',
        spent: sumDecimal(amounts),
        calls: amounts.length,
        createdAt: a.createdAt.toISOString(),
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

  function computeStats(): Stats {
    const decisions = feed.filter((f) => f.kind === 'decision');
    const settled = feed.filter((f) => f.kind === 'settled');
    const shadow = feed.filter((f) => f.kind === 'shadow');
    const latencies = decisions
      .map((d) => d.latencyMs)
      .filter((n): n is number => typeof n === 'number');
    const avg = latencies.length ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0;
    const gateStats = gate.stats();
    return {
      decisions: decisions.length,
      allow: decisions.filter((d) => d.outcome === 'allow').length,
      deny: decisions.filter((d) => d.outcome === 'deny').length,
      escalate: decisions.filter((d) => d.outcome === 'escalate').length,
      settled: settled.length,
      shadow: shadow.length,
      settledValue: sumDecimal(settled.map((s) => s.amount ?? '0')),
      shadowValue: sumDecimal(shadow.map((s) => s.amount ?? '0')),
      agents: engine.agents.list().length,
      chainLinks: engine.decisions().length,
      avgLatencyMs: Math.round(avg * 1000) / 1000,
      revenue: sumDecimal(Object.values(gateStats.revenue)),
      quoted: gateStats.quoted,
      gateRefused: gateStats.refused,
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
  });

  // ── agent provisioning ───────────────────────────────────────────────────
  // Engine writes return promises for durable stores; this world is in-memory,
  // where the effect lands synchronously before the (already-resolved) promise,
  // so the view emits below see it. `void` documents the deliberate non-await.
  function addAgentPolicy(name: string, agentId: string, wallet: { address: string; mode: 'sdk' | 'session-key' }): void {
    void engine.registerAgent({
      id: agentId,
      orgId: newId('org'),
      name,
      wallets: [{ chain: 'base', address: wallet.address, mode: wallet.mode }],
      status: 'active',
      createdAt: new Date(),
    });
    void engine.addPolicy({
      policyId: `policy-${name}`,
      appliesTo: { agents: [agentId] },
      rules: [
        { id: 'tx-cap', deny: { amountGt: TX_CAP } },
        { id: 'hour-budget', deny: { rollingSum: { window: '1h', gt: HOUR_BUDGET } } },
      ],
      default: 'allow',
    });
    emit({ type: 'agents', agents: viewAgents() });
    emit({ type: 'policies', policies: viewPolicies() });
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
  function provisionAgent(name: string): {
    agentId: string;
    wallet: string;
    fetch: FetchLike;
    lastHeader: () => string;
  } {
    const agentId = newId('agt');
    const wallet = `0x${name.replace(/[^a-z0-9]/gi, '')}Wallet`;
    addAgentPolicy(name, agentId, { address: wallet, mode: 'sdk' });
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
  function provisionSessionAgent(name: string): {
    agentId: string;
    wallet: string;
    fetch: FetchLike;
    sessionToken: string;
    lastSignRequest: () => SignRequest | undefined;
  } {
    const agentId = newId('agt');
    const wallet = signer.registerWallet(agentId, generatePrivateKey());
    addAgentPolicy(name, agentId, { address: wallet, mode: 'session-key' });
    const { token } = signer.createSession({
      agentId,
      capAmount: SESSION_CAP,
      ttlSeconds: 24 * 3600,
    });
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
    const sdk = provisionAgent(name);
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
    const session = provisionSessionAgent(sessionName);
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

    demo = { running: false, phase: 'idle' };
    emit({ type: 'demo', demo });
  }

  // ── public API ─────────────────────────────────────────────────────────────
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

  function freeze(agentId: string): boolean {
    if (!engine.agents.list().some((a) => a.id === agentId)) return false;
    void engine.freeze(agentId); // in-memory: effect is synchronous (see addAgentPolicy)
    emit({ type: 'agents', agents: viewAgents() });
    emit({ type: 'stats', stats: computeStats() });
    return true;
  }

  function unfreeze(agentId: string): boolean {
    if (!engine.agents.list().some((a) => a.id === agentId)) return false;
    void engine.unfreeze(agentId); // in-memory: effect is synchronous (see addAgentPolicy)
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
      demo,
      publicKey: engine.publicKeyPem,
      startedAt,
    };
  }

  function subscribe(listener: (ev: ServerEvent) => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  async function close(): Promise<void> {
    await app.close();
  }

  // Seed an initial story so the console is alive on first load.
  await playScenario(false);

  return { getState, subscribe, freeze, unfreeze, pingAgent, runDemo, close };
}
