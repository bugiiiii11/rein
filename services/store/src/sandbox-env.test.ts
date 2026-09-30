import { describe, it, expect } from 'vitest';
import { sandboxFromEnv } from './server.js';

// A throwaway key: never funded, used only to derive an address offline.
const KEY = `0x${'11'.repeat(32)}`;

describe('sandboxFromEnv (the hosted bin)', () => {
  it('is off unless REIN_SANDBOX=1', async () => {
    expect(await sandboxFromEnv({})).toBeUndefined();
    expect(await sandboxFromEnv({ REIN_SANDBOX: 'true' })).toBeUndefined();
  });

  it('runs advisory-only without a faucet key', async () => {
    const s = await sandboxFromEnv({ REIN_SANDBOX: '1', REIN_SANDBOX_DAILY_CAP: '50' });
    expect(s?.options.dailyCap).toBe(50);
    expect(s?.options.drip).toBeUndefined();
    expect(s?.describe).toContain('no drip');
  });

  it('builds a Base Sepolia drip from a faucet key, and names the address to fund', async () => {
    const s = await sandboxFromEnv({
      REIN_SANDBOX: '1',
      REIN_SANDBOX_FAUCET_KEY: KEY,
      REIN_SANDBOX_DRIP_USDC: '0.02',
    });
    expect(typeof s?.options.drip).toBe('function');
    expect(s?.describe).toMatch(/drips 0\.02 test USDC from 0x[0-9a-fA-F]{40} \(Base Sepolia\)/);
  });

  it('refuses a malformed faucet key or limit rather than booting half-configured', async () => {
    await expect(
      sandboxFromEnv({ REIN_SANDBOX: '1', REIN_SANDBOX_FAUCET_KEY: '0xabc' }),
    ).rejects.toThrow(/64 hex/);
    await expect(
      sandboxFromEnv({ REIN_SANDBOX: '1', REIN_SANDBOX_DAILY_CAP: '-1' }),
    ).rejects.toThrow(/positive/);
  });
});
