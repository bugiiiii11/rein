import type { ReputationSubject } from '@rein/core';

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

/** The evidence store: one record per subject, created on first sighting. */
export class EvidenceLedger {
  private readonly records = new Map<string, SubjectEvidence>();

  /** Get-or-create the record for a subject and stamp first/last seen. */
  touch(subject: ReputationSubject, atMs: number): SubjectEvidence {
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
}
