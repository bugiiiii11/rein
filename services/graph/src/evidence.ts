import { sumDecimal, type ReputationSubject } from '@rein/core';

/** A value that may be produced synchronously or awaited (durable writes). */
export type MaybePromise<T> = T | Promise<T>;

/** One settled-money edge to a counterparty (the "graph" in reputation graph). */
export interface CounterpartyLine {
  settled: number;
  /** Settled decimal volume across this edge. */
  volume: string;
}

/**
 * Everything the graph has observed about one subject. Counters are raw and
 * append-only — scoring (scoring.ts) is a pure function over this record, so a
 * score is always re-derivable and explainable from the evidence behind it.
 */
export interface SubjectEvidence {
  subject: ReputationSubject;
  firstSeenMs: number;
  lastSeenMs: number;
  /** Payment attempts observed (allowed intents, presented payments). */
  attempts: number;
  /** Confirmed settlements (indexer-reconciled or gate-receipted). */
  settled: number;
  /** Settled decimal volume. */
  volume: string;
  /** Refusals by code (gate refusal codes, signer refusal codes). */
  refusals: Record<string, number>;
  /** Managed-wallet spend with no ALLOW decision behind it (bypass). */
  shadowSpends: number;
  /** Manual out-of-band reports (chargebacks, fraud complaints). */
  disputes: number;
  /** Manual out-of-band vouches. */
  endorsements: number;
  /** Who this subject has settled money with, keyed by subjectKey(). */
  counterparties: Map<string, CounterpartyLine>;
}

/**
 * Canonical subject identity. Hosts and EVM addresses are case-insensitive,
 * so they normalize to lowercase; ULID agent ids are case-sensitive and pass
 * through. Note the two id spaces under kind "agent": the engine names agents
 * by ULID, a gate names them by paying wallet — linking the two is an
 * ERC-8004 identity job, queued for a later phase.
 */
export function normalizeSubject(subject: ReputationSubject): ReputationSubject {
  const id =
    subject.kind === 'vendor' || subject.id.startsWith('0x') || subject.id.startsWith('0X')
      ? subject.id.toLowerCase()
      : subject.id;
  return { kind: subject.kind, id };
}

export function subjectKey(subject: ReputationSubject): string {
  const normal = normalizeSubject(subject);
  return `${normal.kind}:${normal.id}`;
}

/**
 * The evidence store seam the graph depends on. Writes may be asynchronous (a
 * durable ledger persists behind them); reads are synchronous from the
 * hydrated working set so `score()` / `payerCheck()` stay sync in the gate hot
 * path. Mutations are explicit, atomic operations rather than a returned record
 * the caller mutates — that is what lets a durable implementation persist them.
 */
export interface EvidenceLedgerPort {
  /** A payment attempt (allowed intent / presented payment). */
  recordAttempt(subject: ReputationSubject, atMs: number): MaybePromise<void>;
  /** A confirmed settlement between two subjects (credits both sides + the edge). */
  recordSettlement(
    a: ReputationSubject,
    b: ReputationSubject,
    amount: string,
    atMs: number,
  ): MaybePromise<void>;
  /** A refusal against a subject, by code. */
  recordRefusal(subject: ReputationSubject, code: string, atMs: number): MaybePromise<void>;
  /** Managed-wallet spend with no ALLOW behind it. */
  recordShadowSpend(subject: ReputationSubject, atMs: number): MaybePromise<void>;
  /** An out-of-band dispute. */
  recordDispute(subject: ReputationSubject, atMs: number): MaybePromise<void>;
  /** An out-of-band endorsement. */
  recordEndorsement(subject: ReputationSubject, atMs: number): MaybePromise<void>;
  get(subject: ReputationSubject): SubjectEvidence | undefined;
  getByKey(key: string): SubjectEvidence | undefined;
  all(): IterableIterator<SubjectEvidence>;
  readonly size: number;
  /**
   * Await any pending durable writes (no-op in memory). Durable
   * implementations surface write failures HERE — the graph fire-and-forgets
   * its writes (a bus handler cannot await), so flush() is the error channel.
   */
  flush?(): Promise<void>;
}

/** The evidence store: one record per subject, created on first sighting. */
export class EvidenceLedger implements EvidenceLedgerPort {
  private readonly records = new Map<string, SubjectEvidence>();

  recordAttempt(subject: ReputationSubject, atMs: number): void {
    this.touch(subject, atMs).attempts += 1;
  }

  recordSettlement(
    a: ReputationSubject,
    b: ReputationSubject,
    amount: string,
    atMs: number,
  ): void {
    for (const [subject, other] of [
      [a, b],
      [b, a],
    ] as const) {
      const ev = this.touch(subject, atMs);
      ev.settled += 1;
      ev.volume = sumDecimal([ev.volume, amount]);
      const key = subjectKey(other);
      const line = ev.counterparties.get(key) ?? { settled: 0, volume: '0' };
      line.settled += 1;
      line.volume = sumDecimal([line.volume, amount]);
      ev.counterparties.set(key, line);
    }
  }

  recordRefusal(subject: ReputationSubject, code: string, atMs: number): void {
    const ev = this.touch(subject, atMs);
    ev.refusals[code] = (ev.refusals[code] ?? 0) + 1;
  }

  recordShadowSpend(subject: ReputationSubject, atMs: number): void {
    this.touch(subject, atMs).shadowSpends += 1;
  }

  recordDispute(subject: ReputationSubject, atMs: number): void {
    this.touch(subject, atMs).disputes += 1;
  }

  recordEndorsement(subject: ReputationSubject, atMs: number): void {
    this.touch(subject, atMs).endorsements += 1;
  }

  get(subject: ReputationSubject): SubjectEvidence | undefined {
    return this.records.get(subjectKey(subject));
  }

  getByKey(key: string): SubjectEvidence | undefined {
    return this.records.get(key);
  }

  all(): IterableIterator<SubjectEvidence> {
    return this.records.values();
  }

  get size(): number {
    return this.records.size;
  }

  /**
   * Insert a fully-formed record verbatim — the hydration primitive a durable
   * store uses to rebuild the working set on open. Bypasses the live counters
   * (the record already holds its accumulated state and timestamps).
   */
  load(record: SubjectEvidence): void {
    this.records.set(subjectKey(record.subject), record);
  }

  /** Get-or-create the record for a subject and stamp first/last seen. */
  private touch(subject: ReputationSubject, atMs: number): SubjectEvidence {
    const key = subjectKey(subject);
    let record = this.records.get(key);
    if (!record) {
      record = {
        subject: normalizeSubject(subject),
        firstSeenMs: atMs,
        lastSeenMs: atMs,
        attempts: 0,
        settled: 0,
        volume: '0',
        refusals: {},
        shadowSpends: 0,
        disputes: 0,
        endorsements: 0,
        counterparties: new Map(),
      };
      this.records.set(key, record);
    }
    if (atMs < record.firstSeenMs) record.firstSeenMs = atMs;
    if (atMs > record.lastSeenMs) record.lastSeenMs = atMs;
    return record;
  }
}
