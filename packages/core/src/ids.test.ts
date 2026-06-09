import { describe, it, expect } from 'vitest';
import { ulid, newId } from './ulid.js';
import { AgentId, PolicyId, prefixedId } from './ids.js';

describe('ulid', () => {
  it('produces 26-char Crockford base32 ids', () => {
    const id = ulid();
    expect(id).toHaveLength(26);
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('is time-sortable: later seed sorts after earlier seed', () => {
    const earlier = ulid(1700000000000);
    const later = ulid(1800000000000);
    expect(earlier < later).toBe(true);
  });

  it('is collision-resistant across many calls', () => {
    const ids = new Set(Array.from({ length: 5000 }, () => ulid()));
    expect(ids.size).toBe(5000);
  });
});

describe('newId / prefixedId', () => {
  it('generates ids that validate against their prefixed schema', () => {
    const agentId = newId('agt');
    expect(AgentId.safeParse(agentId).success).toBe(true);

    const policyId = newId('pol');
    expect(PolicyId.safeParse(policyId).success).toBe(true);
  });

  it('rejects mismatched or malformed prefixes', () => {
    expect(AgentId.safeParse(newId('pol')).success).toBe(false);
    expect(AgentId.safeParse('agt_not-a-ulid').success).toBe(false);
    expect(prefixedId('int').safeParse('int_0000000000000000000000000A').success).toBe(true);
  });
});
