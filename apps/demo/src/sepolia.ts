/**
 * Rein — REAL x402 rails demo on Base Sepolia.
 *
 * One guarded payment, end to end, on a real chain:
 *   402 → policy evaluate → EIP-3009 signature → hosted facilitator settles
 *   on-chain (it pays the gas) → tx hash on BaseScan → the on-chain indexer
 *   reconciles the settlement back to the intent via the authorization nonce.
 * Then the counter-example: a rogue payment that bypasses the guard, flagged
 * as shadow.spend.
 *
 * First run generates a wallet into the repo-root .env and exits — fund it
 * with Base Sepolia USDC at https://faucet.circle.com (no ETH needed), then
 * run again. Spends $0.02 of testnet USDC per full run.
 *
 * Run (PowerShell — the CA var matters on machines with TLS interception):
 *   $env:NODE_EXTRA_CA_CERTS = "$HOME\.rein-dev-ca.pem"
 *   pnpm --filter @rein/demo demo:sepolia
 */

import type { AddressInfo } from 'node:net';
import type { Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { PaymentIntent, newId } from '@rein/core';
import { PolicyEngine, buildServer } from '@rein/policy-engine';
import { createGuard } from '@rein/sdk';
import {
  CIRCLE_FAUCET_URL,
  FacilitatorClient,
  OnchainIndexer,
  basescanTxUrl,
  createBaseSepoliaClient,
  createX402Payer,
  createRealVendor,
  generateWallet,
  getUsdcBalance,
} from '@rein/x402-rails';
import { appendEnv, readEnv } from './env.js';

const VENDOR_URL = 'https://demo.rein.dev/v1/report';
const ATOMIC_PRICE = '10000'; // $0.01 USDC
const W = 64;

const bar = (c: string) => c.repeat(W);
const section = (label: string) => `\n${bar('─')}\n ${label}\n${bar('─')}`;

async function main() {
  console.log('\n' + bar('═'));
  console.log('  Rein  ·  Real x402 rails on Base Sepolia');
  console.log(bar('═'));

  // ── Wallet bootstrap ────────────────────────────────────────────────────────
  let privateKey = readEnv('REIN_SEPOLIA_PRIVATE_KEY') as Hex | undefined;
  if (privateKey === undefined) {
    const agent = generateWallet();
    const vendorWallet = generateWallet();
    const path = appendEnv({
      REIN_SEPOLIA_PRIVATE_KEY: agent.privateKey,
      REIN_SEPOLIA_VENDOR_ADDRESS: vendorWallet.address,
    });
    console.log(`\n  Generated a fresh agent wallet and saved it to ${path}`);
    console.log(`\n  Agent wallet   ${agent.address}`);
    console.log(`  Vendor address ${vendorWallet.address}  (where the demo vendor gets paid)`);
    console.log(`\n  Next step: fund the AGENT wallet with Base Sepolia USDC (testnet, free):`);
    console.log(`    1. Open ${CIRCLE_FAUCET_URL}`);
    console.log(`    2. Pick "USDC" + network "Base Sepolia", paste ${agent.address}`);
    console.log(`    3. Re-run this demo.  (No ETH needed — the facilitator pays gas.)`);
    return;
  }

  const wallet = privateKeyToAccount(privateKey).address;
  const vendorAddress = readEnv('REIN_SEPOLIA_VENDOR_ADDRESS') ?? wallet;
  const rpcUrl = readEnv('REIN_SEPOLIA_RPC_URL');
  const chainClient = createBaseSepoliaClient(rpcUrl);

  // ── Funding gate ────────────────────────────────────────────────────────────
  const balance = await getUsdcBalance(chainClient, wallet);
  if (balance < BigInt(ATOMIC_PRICE) * 2n) {
    console.log(`\n  Agent wallet ${wallet}`);
    console.log(`  USDC balance: ${(Number(balance) / 1e6).toFixed(2)} — needs at least $0.02.`);
    console.log(`\n  Fund it (free) at ${CIRCLE_FAUCET_URL} → USDC → Base Sepolia, then re-run.`);
    console.log(`  No ETH needed — the facilitator pays gas.`);
    return;
  }

  // ── Preflight: hosted facilitator reachable? ────────────────────────────────
  const facilitator = new FacilitatorClient();
  try {
    await facilitator.supported();
  } catch (err) {
    console.error(`\n  Cannot reach the hosted facilitator (${facilitator.url}).`);
    console.error(
      `  On machines with HTTPS interception (Avast), set the CA before launching:`,
    );
    console.error(`    $env:NODE_EXTRA_CA_CERTS = "$HOME\\.rein-dev-ca.pem"`);
    throw err;
  }

  // ── Rig: engine + indexer + vendor + guard ──────────────────────────────────
  const t0 = Date.now();
  const engine = new PolicyEngine();
  const app = buildServer(engine);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const engineUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;

  const agentId = newId('agt');
  engine.registerAgent({
    id: agentId,
    orgId: newId('org'),
    name: 'sepolia-agent',
    wallets: [{ chain: 'base', address: wallet, mode: 'sdk' }],
    status: 'active',
    createdAt: new Date(),
  });

  const indexer = new OnchainIndexer({
    client: chainClient,
    agents: () => engine.agents.list(),
    facilitator: 'x402.org',
    onError: (err) => console.warn(`  (indexer RPC hiccup, retrying: ${String(err).slice(0, 80)})`),
  });
  indexer.connectEngine(engine);
  await indexer.start();

  const vendor = createRealVendor({
    facilitator,
    atomicPrice: ATOMIC_PRICE,
    payTo: vendorAddress,
    description: 'Rein demo report',
    body: { report: 'paid content', source: 'rein-demo' },
  });

  const guard = createGuard({
    engineUrl,
    agentId,
    fetch: vendor.fetch,
    payer: createX402Payer({ privateKey }),
  });
  await guard.client.addPolicy({
    policyId: 'sepolia-policy',
    appliesTo: { agents: [agentId] },
    rules: [{ id: 'tx-cap', deny: { amountGt: '0.05' } }],
    default: 'allow',
  });

  console.log(`\n  Agent     ${agentId}`);
  console.log(`  Wallet    ${wallet}  [base-sepolia · sdk mode]`);
  console.log(`  Balance   $${(Number(balance) / 1e6).toFixed(2)} USDC`);
  console.log(`  Engine    ${engineUrl}`);
  console.log(`  Vendor    demo.rein.dev → ${vendorAddress.slice(0, 10)}…  ·  $0.01 / call`);
  console.log(`  Settles   via ${facilitator.url}  (real on-chain USDC)`);

  try {
    // ── Scenario A: guarded real payment ──────────────────────────────────────
    console.log(section('Scenario A  ·  Guarded payment, settled on-chain'));
    console.log('  402 intercepted → policy allow → EIP-3009 signed → facilitator settling…');

    const res = await guard.wrap()(VENDOR_URL);
    if (res.status !== 200) throw new Error(`expected 200, got ${res.status}`);
    const receipt = guard.receipts().at(-1)!;
    const txHash = receipt.settlement?.txHash;
    if (!txHash) throw new Error('settlement missing from receipt');

    console.log(`\n  ✓ ALLOW   $${receipt.amount} USDC  →  settled on Base Sepolia`);
    console.log(`  tx        ${txHash}`);
    console.log(`  BaseScan  ${basescanTxUrl(txHash)}`);

    console.log('\n  Waiting for the on-chain indexer to reconcile (block + poll)…');
    const settled = await indexer.waitFor(
      (e) => e.type === 'payment.settled' && e.payment.txHash.toLowerCase() === txHash.toLowerCase(),
      120_000,
    );
    if (settled.type !== 'payment.settled') throw new Error('unreachable');
    const matches = settled.payment.intentId === receipt.intentId;
    console.log(`  ✓ payment.settled  intent ${settled.payment.intentId}  block ${settled.payment.blockNumber}`);
    console.log(`    nonce-memo reconciliation: intent id ${matches ? 'MATCHES the receipt' : 'MISMATCH!'}`);
    if (!matches) throw new Error('indexer reconciled the wrong intent');

    // ── Scenario B: shadow spend ───────────────────────────────────────────────
    console.log(section('Scenario B  ·  Rogue payment, bypassing the guard'));
    console.log('  The agent signs a payment for an intent NO policy decision allowed.');
    console.log('  The facilitator is not Rein-privileged — it settles anyway…');

    const rogueIntent = PaymentIntent.parse({
      id: newId('int'), // never submitted to the engine — no ALLOW behind it
      agentId,
      vendor: { host: 'demo.rein.dev', address: vendorAddress },
      resource: '/v1/report',
      amount: '0.01',
      asset: 'USDC',
      chain: 'base',
      nonce: 'rogue',
      createdAt: new Date(),
    });
    const rogueHeader = await createX402Payer({ privateKey })(
      vendor.requirementFor(VENDOR_URL),
      rogueIntent,
    );
    const rogueRes = await vendor.fetch(VENDOR_URL, { headers: { 'X-PAYMENT': rogueHeader } });
    console.log(`\n  Vendor served the rogue payment: HTTP ${rogueRes.status} (it settled on-chain).`);

    console.log('  Waiting for the indexer to flag it…');
    const shadow = await indexer.waitFor((e) => e.type === 'shadow.spend', 120_000);
    if (shadow.type !== 'shadow.spend') throw new Error('unreachable');
    console.log(`  ✓ shadow.spend  agent ${shadow.agentId}  $${shadow.amount}`);
    console.log(`    tx        ${shadow.txHash}`);
    console.log(`    BaseScan  ${basescanTxUrl(shadow.txHash)}`);

    // ── Summary ────────────────────────────────────────────────────────────────
    console.log('\n' + bar('═'));
    console.log('  Summary');
    console.log(bar('═'));
    console.log(`
  Receipts:          ${guard.receipts().length}  (guarded calls)
  Settled payments:  ${indexer.settledPayments().length}  (reconciled on-chain via nonce memo)
  Shadow spends:     ${indexer.shadowSpends().length}  (on-chain spend with no ALLOW decision)
  Decision log:      ${engine.decisions().length} entries  (ed25519-signed, sha256-chained)
  Elapsed:           ${((Date.now() - t0) / 1000).toFixed(1)}s
`);
    console.log('  Both transactions are real — open the BaseScan links above.');
    console.log('\n' + bar('═'));
    console.log('  Done.\n');
  } finally {
    indexer.stop();
    await app.close();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
