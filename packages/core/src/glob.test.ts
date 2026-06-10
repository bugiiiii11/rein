import { describe, it, expect } from 'vitest';
import { globMatch, globMatchAny } from './glob.js';

describe('globMatch', () => {
  it('matches exact strings and wildcards', () => {
    expect(globMatch('api.example.com', 'api.example.com')).toBe(true);
    expect(globMatch('*.trusted.io', 'api.trusted.io')).toBe(true);
    expect(globMatch('*.trusted.io', 'deep.api.trusted.io')).toBe(true);
    expect(globMatch('agt_research_*', 'agt_research_01J')).toBe(true);
  });

  it('does not match across the wrong boundaries', () => {
    expect(globMatch('*.trusted.io', 'trusted.io')).toBe(false);
    expect(globMatch('api.example.com', 'evil.com')).toBe(false);
    expect(globMatch('agt_research_*', 'agt_ops_1')).toBe(false);
  });

  it('treats regex metacharacters in the pattern as literals (no injection)', () => {
    expect(globMatch('a.b', 'aXb')).toBe(false); // '.' is literal, not "any char"
    expect(globMatch('a.b', 'a.b')).toBe(true);
    expect(globMatch('(a+)+', '(a+)+')).toBe(true);
  });

  it('globMatchAny checks the whole list', () => {
    expect(globMatchAny(['api.example.com', '*.trusted.io'], 'x.trusted.io')).toBe(true);
    expect(globMatchAny(['api.example.com', '*.trusted.io'], 'evil.com')).toBe(false);
  });
});
