import { describe, it, expect } from 'vitest';
import type { Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { newId, type Decision, type PaymentIntent } from '@reinconsole/core';
import { PaymentRequirement, v2Requirements, wrapPaymentV2 } from '@reinconsole/sdk';
import { FacilitatorClient } from './facilitator.js';
import { createX402Payer } from './payer.js';
import { TESTNET } from './profiles.js';
import { createChainClient, getProfileUsdcBalance } from './wallet.js';
import { decodePaymentHeader } from './wire.js';

/**
 * LIVE: PayAI's facilitator, driven through Rein's own FacilitatorClient on
 * Base Sepolia. Same gate and same wallet as live.test.ts:
 *
 *   export NODE_EXTRA_CA_CERTS=$HOME/.rein-dev-ca.pem RUN_LIVE=1
 *   pnpm --filter @reinconsole/x402-rails test -- payai
 *
 * Why this exists (S74): PayAI answered /supported and /discovery keyless on
 * Base mainnet and Sepolia, but /supported is parsed as `unknown`. /verify and
 * /settle go through VerifyResponse.parse / SettleResponse.parse, so a
 * response shape that differs from x402.org's THROWS -- and that can only be
 * seen with a real settlement. Sepolia settles at $0 facilitator fee, so this
 * de-risks the mainnet facilitator without touching mainnet.
 *
 * The URL is passed EXPLICITLY. TESTNET.facilitatorUrl stays x402.org: the
 * invitee kits run on that profile, and pointing a live beta at a
 * facilitator no settlement has proven is the S59 class of mistake.
 *
 * A schema mismatch surfaces as a ZodError from facilitator.ts, not as a
 * network error. The settle test moves $0.001 of testnet USDC per run
 * (payer -> REIN_SEPOLIA_VENDOR_ADDRESS, or back to itself).
 */
const PAYAI_URL = 'https://facilitator.payai.network';
const KEY = process.env['REIN_SEPOLIA_PRIVATE_KEY'] as Hex | undefined;
const live = Boolean(process.env['RUN_LIVE']) && KEY !== undefined;

const ATOMIC_PRICE = '1000';

function requirementFor(resource: string, payTo: string): PaymentRequirement {
  return PaymentRequirement.parse({
    scheme: 'exact',
    network: TESTNET.network,
    maxAmountRequired: ATOMIC_PRICE,
    resource,
    description: 'rein PayAI live probe',
    mimeType: 'application/json',
    payTo,
    maxTimeoutSeconds: 300,
    asset: TESTNET.usdc,
    extra: { ...TESTNET.eip712 },
  });
}

/** A signed v1 X-PAYMENT header. The payer only reads the intent id (nonce). */
async function sign(requirement: PaymentRequirement): Promise<string> {
  return createX402Payer({ privateKey: KEY! })(
    requirement,
    { id: newId('int') } as PaymentIntent,
    undefined as unknown as Decision,
  );
}

/**
 * A key with no USDC is "no funded wallet": the caller skips rather than
 * fails. Verify would reject it with insufficient_funds, which reads as a
 * PayAI problem when it is a faucet problem.
 */
async function funded(): Promise<boolean> {
  const chain = createChainClient(TESTNET, process.env['REIN_SEPOLIA_RPC_URL']);
  const wallet = privateKeyToAccount(KEY!).address;
  return (await getProfileUsdcBalance(chain, wallet, TESTNET)) >= BigInt(ATOMIC_PRICE);
}

describe.skipIf(!live)('live: PayAI facilitator on Base Sepolia', () => {
  const facilitator = new FacilitatorClient({ url: PAYAI_URL });

  it('verifies and settles a v1 exact payment on-chain', { timeout: 120_000 }, async (ctx) => {
    const wallet = privateKeyToAccount(KEY!).address;
    const chain = createChainClient(TESTNET, process.env['REIN_SEPOLIA_RPC_URL']);
    if (!(await funded())) return ctx.skip();

    const requirement = requirementFor(
      'https://demo.rein.dev/v1/payai-settle',
      process.env['REIN_SEPOLIA_VENDOR_ADDRESS'] ?? wallet,
    );
    const payment = decodePaymentHeader(await sign(requirement));

    const verified = await facilitator.verify(payment, requirement);
    expect(verified.invalidReason).toBeUndefined();
    expect(verified.isValid).toBe(true);

    const settled = await facilitator.settle(payment, requirement);
    expect(settled.errorReason).toBeUndefined();
    expect(settled.success).toBe(true);
    expect(settled.transaction).toMatch(/^0x[0-9a-fA-F]{64}$/);
    // The guard puts this on the receipt; a dialect drift here ('eip155:84532'
    // on a v1 settle) would silently change what receipts say.
    expect(settled.network).toBe(TESTNET.network);

    // "success: true" is the facilitator's word. The indexer only ever
    // believes the chain, so check that the transfer actually landed.
    const receipt = await chain.waitForTransactionReceipt({
      hash: settled.transaction as Hex,
      timeout: 90_000,
    });
    expect(receipt.status).toBe('success');
  });

  it('verifies a rewrapped v2 envelope (no settle)', { timeout: 30_000 }, async (ctx) => {
    if (!(await funded())) return ctx.skip();
    const wallet = privateKeyToAccount(KEY!).address;
    const requirement = requirementFor(
      'https://demo.rein.dev/v1/payai-v2-verify',
      process.env['REIN_SEPOLIA_VENDOR_ADDRESS'] ?? wallet,
    );
    const envelope = JSON.parse(
      Buffer.from(wrapPaymentV2(await sign(requirement), requirement), 'base64').toString('utf8'),
    ) as { x402Version: number } & Record<string, unknown>;

    const verified = await facilitator.verify(envelope, v2Requirements(requirement));

    expect(verified.invalidReason).toBeUndefined();
    expect(verified.isValid).toBe(true);
  });
});
