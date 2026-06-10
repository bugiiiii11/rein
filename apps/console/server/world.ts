/**
 * The console "world": one live instance of the whole Rein stack wired together
 * — the real policy engine (over HTTP, exactly as an SDK client would reach it)
 * plus the mock rails (ledger, facilitator, indexer). It subscribes to BOTH the
 * engine bus (`intent.created`, `decision.made`) and the indexer bus
 * (`payment.settled`, `shadow.spend`), normalizes them into render-ready feed
 * items, and broadcasts to any connected SSE clients.
 *
 * This is the only place the moving parts are assembled; the HTTP/SSE layer in
 * `api.ts` is a thin shell over the methods returned here.
 */
import type { AddressInfo } from 'node:net';
import { newId, sumDecimal, type Agent, type Decision, type PaymentIntent } from '@rein/core';
import { PolicyEngine, buildServer } from '@rein/policy-engine';
import { createGuard, PaymentBlockedError } from '@rein/sdk';
import { MockLedger, MockFacilitator, MockIndexer, createMockVendor } from '@rein/mock-rails';
import type {
  AgentView,
  ConsoleState,
  DemoStatus,
  FeedItem,
  PolicyView,
  PolicyRuleView,
  ServerEvent,
  Stats,
} from './wire';

const VENDOR_URL = 'https://api.data.test/v1/query';
const PREMIUM_URL = 'https://api.data.test/v1/premium';
const PRICE_ATOMIC = '10000'; // $0.01 USDC (6 decimals)
const PREMIUM_ATOMIC = '5000000'; // $5.00 USDC
const TX_CAP = '0.50';
const HOUR_BUDGET = '0.04';
const FEED_CAP = 300;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface AgentRuntime {
  wallet: string;
  /** A guard-wrapped fetch bound to this agent against the $0.01 vendor. */
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

  // Two paywalled vendors that share the facilitator/ledger.
  const vendor = createMockVendor({ facilitator, atomicPrice: PRICE_ATOMIC, payTo: '0xVendorTreasury' });
  const premium = createMockVendor({ facilitator, atomicPrice: PREMIUM_ATOMIC, payTo: '0xPremiumVendor' });

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

  function computeStats(): Stats {
    const decisions = feed.filter((f) => f.kind === 'decision');
    const settled = feed.filter((f) => f.kind === 'settled');
    const shadow = feed.filter((f) => f.kind === 'shadow');
    const latencies = decisions
      .map((d) => d.latencyMs)
      .filter((n): n is number => typeof n === 'number');
    const avg = latencies.length ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0;
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
    };
  }

  // ── event wiring ───────────────────────────────────────────────────────────
  engine.onEvent((ev) => {
    if (ev.type === 'intent.created') {
      intents.set(ev.intent.id, ev.intent);
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

  // ── agent provisioning ───────────────────────────────────────────────────
  function provisionAgent(name: string): { agentId: string; wallet: string } {
    const agentId = newId('agt');
    const wallet = `0x${name.replace(/[^a-z0-9]/gi, '')}Wallet`;
    engine.registerAgent({
      id: agentId,
      orgId: newId('org'),
      name,
      wallets: [{ chain: 'base', address: wallet, mode: 'sdk' }],
      status: 'active',
      createdAt: new Date(),
    });
    engine.addPolicy({
      policyId: `policy-${name}`,
      appliesTo: { agents: [agentId] },
      rules: [
        { id: 'tx-cap', deny: { amountGt: TX_CAP } },
        { id: 'hour-budget', deny: { rollingSum: { window: '1h', gt: HOUR_BUDGET } } },
      ],
      default: 'allow',
    });
    const guard = createGuard({ engineUrl, agentId, fetch: vendor.fetch, payer: facilitator.payerFor(wallet) });
    const wrapped = guard.wrap();
    runtimes.set(agentId, {
      wallet,
      ping: async () => {
        try {
          await wrapped(VENDOR_URL);
        } catch (e) {
          if (!(e instanceof PaymentBlockedError)) throw e;
        }
      },
    });
    emit({ type: 'agents', agents: viewAgents() });
    emit({ type: 'policies', policies: viewPolicies() });
    return { agentId, wallet };
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
    const { agentId, wallet } = provisionAgent(name);
    await sleep(gap);

    // 1 — four allowed calls within the rolling budget
    setPhase('normal calls within budget');
    const guard = createGuard({ engineUrl, agentId, fetch: vendor.fetch, payer: facilitator.payerFor(wallet) });
    const fetch = guard.wrap();
    for (let i = 0; i < 4; i++) {
      await fetch(VENDOR_URL);
      await sleep(gap);
    }

    // 2 — the fifth call trips the rolling-budget cap (deny before payment)
    setPhase('rolling-budget cap');
    try {
      await fetch(VENDOR_URL);
    } catch (e) {
      if (!(e instanceof PaymentBlockedError)) throw e;
    }
    await sleep(gap);

    // 3 — a $5.00 vendor trips the per-transaction cap
    setPhase('single-transaction cap');
    const premiumGuard = createGuard({
      engineUrl,
      agentId,
      fetch: premium.fetch,
      payer: facilitator.payerFor(wallet),
    });
    try {
      await premiumGuard.wrap()(PREMIUM_URL);
    } catch (e) {
      if (!(e instanceof PaymentBlockedError)) throw e;
    }
    await sleep(gap);

    // 4 — a direct transfer that bypasses the guard entirely → shadow spend
    setPhase('shadow spend (bypass)');
    ledger.transfer({ chain: 'base', asset: 'USDC', from: wallet, to: '0xDeadVendor', amount: '2.50' });
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
    engine.freeze(agentId);
    emit({ type: 'agents', agents: viewAgents() });
    emit({ type: 'stats', stats: computeStats() });
    return true;
  }

  function unfreeze(agentId: string): boolean {
    if (!engine.agents.list().some((a) => a.id === agentId)) return false;
    engine.unfreeze(agentId);
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
