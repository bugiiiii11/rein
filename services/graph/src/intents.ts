import type { MaybePromise } from './evidence.js';

/**
 * What an `intent.created` event tells us, kept until the matching
 * `payment.settled` (which carries only an intentId) can be attributed.
 */
export interface IntentFacts {
  agentId: string;
  host: string;
  amount: string;
}

export const DEFAULT_CORRELATION_LIMIT = 10_000;

/**
 * Bridges `intent.created` -> later `payment.settled`/`decision.made`. A
 * `payment.settled` event names only an intentId, so the graph remembers every
 * undecided intent until it settles. Bounded (oldest-evicted) so undecided
 * intents that never settle cannot leak. Writes may be async (a durable store
 * persists them so an in-flight intent survives a restart); reads are sync.
 */
export interface IntentCorrelationPort {
  remember(intentId: string, facts: IntentFacts): MaybePromise<void>;
  /** Read the facts without consuming them (decision.made reads, doesn't burn). */
  peek(intentId: string): IntentFacts | undefined;
  /** Read and consume (payment.settled attributes once, then forgets). */
  take(intentId: string): IntentFacts | undefined;
  readonly size: number;
  /**
   * Await any pending durable writes (no-op in memory). Durable
   * implementations surface write failures HERE — the graph fire-and-forgets
   * its writes, so flush() is the error channel.
   */
  flush?(): Promise<void>;
}

/** In-memory correlation map with FIFO eviction once `limit` is reached. */
export class InMemoryIntentStore implements IntentCorrelationPort {
  private readonly intents = new Map<string, IntentFacts>();

  constructor(private readonly limit: number = DEFAULT_CORRELATION_LIMIT) {}

  remember(intentId: string, facts: IntentFacts): void {
    // Re-remembering an existing id is an update, not a new entry — evicting
    // for it would shrink the working set below the bound (and desync a
    // durable mirror, whose upsert adds no row). Updates keep their position,
    // matching an SQL upsert leaving seq unchanged.
    if (!this.intents.has(intentId) && this.intents.size >= this.limit) {
      const oldest = this.intents.keys().next().value;
      if (oldest !== undefined) this.intents.delete(oldest);
    }
    this.intents.set(intentId, facts);
  }

  peek(intentId: string): IntentFacts | undefined {
    return this.intents.get(intentId);
  }

  take(intentId: string): IntentFacts | undefined {
    const facts = this.intents.get(intentId);
    if (facts) this.intents.delete(intentId);
    return facts;
  }

  get size(): number {
    return this.intents.size;
  }
}
