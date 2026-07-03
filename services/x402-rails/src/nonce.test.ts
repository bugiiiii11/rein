import { describe, it, expect } from 'vitest';
import { newId } from '@reinconsole/core';
import { intentNonce } from './nonce.js';

describe('intentNonce', () => {
  it('is deterministic for the same intent id', () => {
    const id = newId('int');
    expect(intentNonce(id)).toBe(intentNonce(id));
  });

  it('is a bytes32 hex string', () => {
    expect(intentNonce(newId('int'))).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('differs across intent ids', () => {
    expect(intentNonce(newId('int'))).not.toBe(intentNonce(newId('int')));
  });
});
