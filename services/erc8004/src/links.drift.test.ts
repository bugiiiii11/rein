import { describe, expect, it } from 'vitest';
import { subjectKey } from '@reinconsole/graph';
import type { ReputationSubject } from '@reinconsole/core';
import { keyOf } from './links.js';

/**
 * DRIFT CANARY: links.ts dedupes link pairs with its own keyOf because this
 * package deliberately never imports @reinconsole/graph at runtime — but the
 * graph's subjectKey is THE normalization contract. If the two ever disagree,
 * a pair links.ts deduped away (or kept) would merge differently in the graph.
 * This test pins them together over every casing/normalization rule; graph is
 * a devDependency here for exactly this file.
 */

const REGISTRY = '0x8004A818BFB912233c491871b3d84c89A494BD9e';

const BATTERY: ReputationSubject[] = [
  // engine ULIDs: case-preserved, never lowercased
  { kind: 'agent', id: 'agt_01JTESTAGENT0000000000000' },
  // 0x wallet ids: case-insensitive (gate-side payers ride the agent kind)
  { kind: 'agent', id: '0xAbCdEf0123456789aBcDeF0123456789AbCdEf01' },
  { kind: 'agent', id: '0XABCDEF0123456789ABCDEF0123456789ABCDEF01' },
  // vendor ids: hosts, always lowercased wholesale
  { kind: 'vendor', id: 'API.Vendor.TEST' },
  { kind: 'vendor', id: '0xTreasuryMIXEDcase' },
  // erc8004 ids: parse->format normalized (registry lowercased, tokenId canonical)
  { kind: 'agent', id: `eip155:84532:${REGISTRY}/42` },
  { kind: 'agent', id: `eip155:84532:${REGISTRY.toLowerCase()}/042` },
  { kind: 'vendor', id: `eip155:84532:${REGISTRY}/42` },
  // malformed eip155-ish strings fall through to the plain rules
  { kind: 'agent', id: 'eip155:junk' },
  { kind: 'vendor', id: 'eip155:junk' },
];

describe('keyOf ↔ subjectKey drift canary', () => {
  it('links.ts keyOf matches @reinconsole/graph subjectKey for every id shape', () => {
    for (const subject of BATTERY) {
      expect(keyOf(subject), `subject ${subject.kind}:${subject.id}`).toBe(subjectKey(subject));
    }
  });
});
