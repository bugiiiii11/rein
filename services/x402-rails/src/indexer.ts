import { EventEmitter } from 'node:events';
import { parseAbi, type Address, type Hex } from 'viem';
import { ReinEvent, type Agent, type Chain, type PaymentIntent } from '@reinconsole/core';
import { atomicToDecimal } from '@reinconsole/sdk';
import { intentNonce } from './nonce.js';
import { BASE_SEPOLIA_USDC } from './wallet.js';

/** The slice of the policy engine the indexer subscribes to (NATS in prod). */
export interface EngineEvents {
  onEvent(handler: (event: ReinEvent) => void): void;
}

/** The two FiatTokenV2 events one transferWithAuthorization settlement emits. */
export const railEventsAbi = parseAbi([
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)',
]);

/** The decoded log shape the indexer consumes. */
export interface RailLog {
  eventName: 'Transfer' | 'AuthorizationUsed';
  transactionHash: Hex | null;
  blockNumber: bigint | null;
  args: {
    from?: Address;
    to?: Address;
    value?: bigint;
    authorizer?: Address;
    nonce?: Hex;
  };
}

/**
 * What the indexer needs from a chain: current head + decoded event logs.
 * viem's PublicClient satisfies this structurally; tests inject a fake.
 */
export interface ChainReader {
  getBlockNumber(): Promise<bigint>;
  getLogs(args: {
    address: Address;
    events: typeof railEventsAbi;
    fromBlock: bigint;
    toBlock: bigint;
  }): Promise<readonly RailLog[]>;
}

export interface OnchainIndexerOptions {
  client: ChainReader;
  /** Token contract whose transfers are watched. Defaults to Base Sepolia USDC. */
  usdcAddress?: Address;
  /** The Rein chain tag recorded on events (testnets map to mainnet). */
  chain?: Chain;
  /**
   * Directory of managed agents and their wallets (the agents service in
   * prod). Called per transfer, so agents registered later are still seen.
   */
  agents: () => readonly Agent[];
  /** Recorded as SettledPayment.facilitator on reconciled payments. */
  facilitator?: string;
  pollIntervalMs?: number;
  /** First block to scan. Defaults to the chain head at start(). */
  fromBlock?: bigint;
  /** Token decimals for amount conversion. */
  decimals?: number;
  /** RPC errors are retried next tick; surface them here if you care. */
  onError?: (err: unknown) => void;
}

/** A `shadow.spend` event, extracted for convenience accessors. */
export type ShadowSpend = Extract<ReinEvent, { type: 'shadow.spend' }>;

/**
 * The real indexer: polls token logs on Base Sepolia and classifies every
 * transfer that leaves a managed agent wallet — the same semantics as the
 * mock indexer, against a real chain.
 *
 * Reconciliation is memo-first via the EIP-3009 nonce: Rein's payer derives
 * the authorization nonce from the intent id, and settlement emits
 * `AuthorizationUsed(authorizer, nonce)` alongside the `Transfer`. A transfer
 * whose nonce resolves to an allowed, unsettled intent of the same agent is
 * `payment.settled`; anything else leaving a managed wallet — random nonce,
 * replay, plain transfer, no ALLOW behind it — is `shadow.spend`. There is no
 * fuzzy fallback on-chain: the nonce IS the memo.
 */
export class OnchainIndexer {
  private readonly options: OnchainIndexerOptions;
  private readonly bus = new EventEmitter();
  private readonly emitted: ReinEvent[] = [];
  /** Every intent the engine has seen, by id (from `intent.created`). */
  private readonly intents = new Map<string, PaymentIntent>();
  /** Intents with an ALLOW decision, by id. */
  private readonly allowed = new Map<string, PaymentIntent>();
  private readonly settledIntents = new Set<string>();
  /** Expected on-chain nonce -> intent id, for every allowed intent. */
  private readonly nonceToIntent = new Map<string, string>();
  private timer: NodeJS.Timeout | undefined;
  private nextBlock: bigint | undefined;
  private scanning = false;

  constructor(options: OnchainIndexerOptions) {
    this.options = options;
  }

  /** Subscribe to a policy engine's event stream to learn which intents were allowed. */
  connectEngine(engine: EngineEvents): void {
    engine.onEvent((event) => {
      if (event.type === 'intent.created') {
        this.intents.set(event.intent.id, event.intent);
      } else if (event.type === 'decision.made' && event.decision.outcome === 'allow') {
        const intent = this.intents.get(event.decision.intentId);
        if (intent) {
          this.allowed.set(intent.id, intent);
          this.nonceToIntent.set(intentNonce(intent.id).toLowerCase(), intent.id);
        }
      }
    });
  }

  /** Begin polling. Scans from `fromBlock` (default: the current head). */
  async start(): Promise<void> {
    if (this.timer !== undefined) return;
    this.nextBlock = this.options.fromBlock ?? (await this.options.client.getBlockNumber()) + 1n;
    const interval = this.options.pollIntervalMs ?? 3000;
    this.timer = setInterval(() => void this.scan(), interval);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  onEvent(handler: (event: ReinEvent) => void): void {
    this.bus.on('event', handler);
  }

  /** Everything the indexer has emitted, oldest first. */
  events(): readonly ReinEvent[] {
    return this.emitted;
  }

  settledPayments() {
    return this.emitted.flatMap((e) => (e.type === 'payment.settled' ? [e.payment] : []));
  }

  shadowSpends(): ShadowSpend[] {
    return this.emitted.filter((e): e is ShadowSpend => e.type === 'shadow.spend');
  }

  /** Resolve when an event (past or future) matches; reject on timeout. */
  waitFor(predicate: (event: ReinEvent) => boolean, timeoutMs = 90_000): Promise<ReinEvent> {
    const existing = this.emitted.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.bus.off('event', handler);
        reject(new Error(`indexer: no matching event within ${timeoutMs}ms`));
      }, timeoutMs);
      const handler = (event: ReinEvent) => {
        if (!predicate(event)) return;
        clearTimeout(timeout);
        this.bus.off('event', handler);
        resolve(event);
      };
      this.bus.on('event', handler);
    });
  }

  /** One poll: fetch logs since the last scanned block and classify them. */
  async scan(): Promise<void> {
    if (this.scanning || this.nextBlock === undefined) return;
    this.scanning = true;
    try {
      const head = await this.options.client.getBlockNumber();
      if (head < this.nextBlock) return;
      const logs = await this.options.client.getLogs({
        address: this.options.usdcAddress ?? BASE_SEPOLIA_USDC,
        events: railEventsAbi,
        fromBlock: this.nextBlock,
        toBlock: head,
      });
      for (const tx of groupByTx(logs)) this.observe(tx);
      // Only advance once the whole range processed — an RPC error above
      // leaves the range to be retried on the next tick.
      this.nextBlock = head + 1n;
    } catch (err) {
      this.options.onError?.(err);
    } finally {
      this.scanning = false;
    }
  }

  private emit(event: ReinEvent): void {
    const parsed = ReinEvent.parse(event);
    this.emitted.push(parsed);
    this.bus.emit('event', parsed);
  }

  private agentFor(from: string): string | undefined {
    const chain = this.options.chain ?? 'base';
    for (const agent of this.options.agents()) {
      const owns = agent.wallets.some((w) => w.chain === chain && sameAddress(w.address, from));
      if (owns) return agent.id;
    }
    return undefined;
  }

  private observe(tx: TxLogs): void {
    for (const transfer of tx.transfers) {
      const from = transfer.args.from;
      if (from === undefined || transfer.args.value === undefined) continue;
      const agentId = this.agentFor(from);
      // Spend from a wallet Rein does not manage is someone else's problem.
      if (agentId === undefined) continue;

      const intent = this.reconcile(tx, from, agentId);
      const at = new Date();
      if (intent) {
        this.settledIntents.add(intent.id);
        this.emit({
          type: 'payment.settled',
          at,
          payment: {
            intentId: intent.id,
            txHash: tx.txHash,
            chain: this.options.chain ?? 'base',
            blockNumber: transfer.blockNumber ?? 0n,
            facilitator: this.options.facilitator,
            confirmedAt: at,
          },
        });
        continue;
      }

      this.emit({
        type: 'shadow.spend',
        at,
        agentId,
        txHash: tx.txHash,
        chain: this.options.chain ?? 'base',
        amount: atomicToDecimal(transfer.args.value.toString(), this.options.decimals ?? 6),
      });
    }
  }

  private reconcile(tx: TxLogs, from: string, agentId: string): PaymentIntent | undefined {
    for (const auth of tx.authorizations) {
      const { authorizer, nonce } = auth.args;
      if (authorizer === undefined || nonce === undefined) continue;
      if (!sameAddress(authorizer, from)) continue;
      const intentId = this.nonceToIntent.get(nonce.toLowerCase());
      if (intentId === undefined) continue;
      const intent = this.allowed.get(intentId);
      if (intent && intent.agentId === agentId && !this.settledIntents.has(intent.id)) {
        return intent;
      }
    }
    return undefined;
  }
}

interface TxLogs {
  txHash: string;
  transfers: RailLog[];
  authorizations: RailLog[];
}

function groupByTx(logs: readonly RailLog[]): TxLogs[] {
  const byTx = new Map<string, TxLogs>();
  for (const log of logs) {
    if (log.transactionHash === null) continue;
    let tx = byTx.get(log.transactionHash);
    if (!tx) {
      tx = { txHash: log.transactionHash, transfers: [], authorizations: [] };
      byTx.set(log.transactionHash, tx);
    }
    (log.eventName === 'Transfer' ? tx.transfers : tx.authorizations).push(log);
  }
  return [...byTx.values()];
}

/** EVM addresses compare case-insensitively. */
function sameAddress(a: string, b: string): boolean {
  return a === b || a.toLowerCase() === b.toLowerCase();
}
