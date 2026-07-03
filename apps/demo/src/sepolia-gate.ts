/**
 * Rein — Gate on REAL rails: a monetized vendor on Base Sepolia.
 *
 * demo:gate ran the vendor side offline (mock rails as the chain). This is the
 * SAME gate with facilitatorClientRails plugged in: a plain Node HTTP API
 * priced at $0.01/call, settling real testnet USDC through the hosted x402
 * facilitator (which pays the gas), while the paying agent stays under Rein
 * guard. The on-chain indexer then reconciles the settlement back to the
 * intent via the authorization nonce — Rein books on both sides of one
 * real payment.
 *
 * Three scenarios; only one costs money ($0.01):
 *   1. The unpaid crawler — a 402 quote on real rails (free)
 *   2. Guarded purchase  — EIP-3009 signed, settled on-chain, reconciled
 *   3. Replay            — the gate burns it BEFORE the facilitator sees it (free)
 *
 * Reuses the demo:sepolia wallet from the repo-root .env — run demo:sepolia
 * first if the wallet does not exist yet (it prints faucet instructions).
 *
 * Run (PowerShell — the CA var matters on machines with TLS interception):
 *   $env:NODE_EXTRA_CA_CERTS = "$HOME\.rein-dev-ca.pem"
 *   pnpm --filter @reinconsole/demo demo:sepolia-gate
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { newId, type ReinEvent } from '@reinconsole/core';
import { PolicyEngine, buildServer } from '@reinconsole/policy-engine';
import { createGuard, PaymentRequired, type Payer } from '@reinconsole/sdk';
import { createGate, facilitatorClientRails, gateMiddleware, type Gate } from '@reinconsole/gate';
import {
  BASE_SEPOLIA_USDC,
  CIRCLE_FAUCET_URL,
  FacilitatorClient,
  OnchainIndexer,
  basescanTxUrl,
  createBaseSepoliaClient,
  createX402Payer,
  getUsdcBalance,
} from '@reinconsole/x402-rails';
import { readEnv } from './env.js';

const ATOMIC_PRICE = '10000'; // $0.01 USDC
const W = 64;

const bar = (c: string) => c.repeat(W);
const section = (label: string) => `\n${bar('─')}\n ${label}\n${bar('─')}`;

/** A plain Node API with the gate's paywall in front — same shape as demo:gate. */
async function startVendor(gate: Gate) {
  const paywall = gateMiddleware(gate);
  const server = http.createServer((req, res) => {
    paywall(req, res, () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ report: 'paid content', source: 'rein-gate-sepolia' }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function main() {
  console.log('\n' + bar('═'));
  console.log('  Rein  ·  Gate on real rails (Base Sepolia)');
  console.log(bar('═'));

  // ── Wallet (reuses demo:sepolia's) ─────────────────────────────────────────
  const privateKey = readEnv('REIN_SEPOLIA_PRIVATE_KEY') as Hex | undefined;
  if (privateKey === undefined) {
    console.log('\n  No agent wallet found in .env — run the wallet bootstrap first:');
    console.log('    pnpm --filter @reinconsole/demo demo:sepolia');
    console.log(`  then fund it at ${CIRCLE_FAUCET_URL} and re-run this demo.`);
    return;
  }
  const wallet = privateKeyToAccount(privateKey).address;
  const vendorAddress = readEnv('REIN_SEPOLIA_VENDOR_ADDRESS') ?? wallet;
  const chainClient = createBaseSepoliaClient(readEnv('REIN_SEPOLIA_RPC_URL'));

  const balance = await getUsdcBalance(chainClient, wallet);
  if (balance < BigInt(ATOMIC_PRICE) * 2n) {
    console.log(`\n  Agent wallet ${wallet}`);
    console.log(`  USDC balance: ${(Number(balance) / 1e6).toFixed(2)} — needs at least $0.02.`);
    console.log(`  Fund it (free) at ${CIRCLE_FAUCET_URL} → USDC → Base Sepolia, then re-run.`);
    return;
  }

  // ── Preflight: hosted facilitator reachable? ────────────────────────────────
  const facilitator = new FacilitatorClient();
  try {
    await facilitator.supported();
  } catch (err) {
    console.error(`\n  Cannot reach the hosted facilitator (${facilitator.url}).`);
    console.error('  On machines with HTTPS interception (Avast), set the CA before launching:');
    console.error('    $env:NODE_EXTRA_CA_CERTS = "$HOME\\.rein-dev-ca.pem"');
    throw err;
  }

  // ── Rig: engine + REAL gate + indexer + guarded agent ───────────────────────
  const t0 = Date.now();
  const engine = new PolicyEngine();
  const app = buildServer(engine);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const engineUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;

  const gateEvents: ReinEvent[] = [];
  const gate = createGate({
    routes: [{ path: '/v1/report', price: '0.01', description: 'Rein gate-sepolia report' }],
    rails: facilitatorClientRails(facilitator),
    payTo: vendorAddress,
    network: 'base-sepolia',
    asset: BASE_SEPOLIA_USDC,
    // The hosted facilitator refuses exact-EVM quotes without the token's
    // EIP-712 domain in extra (invalid_exact_evm_missing_eip712_domain).
    extra: { name: 'USDC', version: '2' },
  });
  gate.onEvent((e) => gateEvents.push(e));
  const lastRefusal = () => {
    const e = gateEvents.at(-1);
    return e?.type === 'gate.refused' ? `[${e.code}] ${e.reason}` : '(no refusal event?)';
  };
  const vendor = await startVendor(gate);

  const agentId = newId('agt');
  await engine.registerAgent({
    id: agentId,
    orgId: newId('org'),
    name: 'gate-sepolia-agent',
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

  // Capture the raw X-PAYMENT header — scenario 3 replays it at the gate.
  let lastHeader = '';
  const innerPayer = createX402Payer({ privateKey });
  const payer: Payer = async (requirement, intent, decision) => {
    lastHeader = await innerPayer(requirement, intent, decision);
    return lastHeader;
  };
  const guard = createGuard({
    engineUrl,
    agentId,
    payer,
    fetch: (input, init) => globalThis.fetch(input, init),
  });
  await guard.client.addPolicy({
    policyId: 'gate-sepolia-policy',
    appliesTo: { agents: [agentId] },
    rules: [{ id: 'tx-cap', deny: { amountGt: '0.05' } }],
    default: 'allow',
  });
  const guarded = guard.wrap();

  console.log(`\n  Vendor    ${vendor.url}  (Node API + gateMiddleware)`);
  console.log(`            /v1/report $0.01 → ${vendorAddress.slice(0, 10)}…  · asset USDC ${BASE_SEPOLIA_USDC.slice(0, 10)}…`);
  console.log(`  Rails     facilitatorClientRails → ${facilitator.url}  (real on-chain USDC)`);
  console.log(`  Engine    ${engineUrl}`);
  console.log(`  Agent     ${agentId}`);
  console.log(`  Wallet    ${wallet}  ·  $${(Number(balance) / 1e6).toFixed(2)} USDC`);

  try {
    // ── Scenario 1: the unpaid crawler (free) ─────────────────────────────────
    console.log(section('Scenario 1  ·  The unpaid crawler — a 402 quote on real rails'));

    const quoted = await fetch(`${vendor.url}/v1/report`);
    const quote = PaymentRequired.parse(await quoted.json());
    const offer = quote.accepts[0]!;
    console.log(`  HTTP ${quoted.status} — the gate quotes, the chain is never touched:`);
    console.log(`    pay      ${offer.maxAmountRequired} atomic USDC ($0.01) on ${offer.network}`);
    console.log(`    to       ${offer.payTo}`);
    console.log(`    asset    ${offer.asset}  (the real token contract)`);

    // ── Scenario 2: the guarded purchase (one real payment) ───────────────────
    console.log(section('Scenario 2  ·  Guarded purchase — settled on-chain, both books agree'));
    console.log('  402 → policy allow → EIP-3009 signed → facilitator settling on-chain…');

    const res = await guarded(`${vendor.url}/v1/report`);
    if (res.status !== 200) throw new Error(`expected 200, got ${res.status}: ${await res.text()}`);
    const agentReceipt = guard.receipts().at(-1)!;
    const gateReceipt = gate.receipts.at(-1)!;
    const txHash = gateReceipt.transaction;

    console.log(`\n  ✓ SERVED  HTTP ${res.status} · ${JSON.stringify(await res.json())}`);
    console.log(`\n  One real payment, both sides keep books:`);
    console.log(`    agent receipt  ${agentReceipt.id.slice(0, 18)}…  tx ${agentReceipt.settlement?.txHash?.slice(0, 18)}…`);
    console.log(`    gate receipt   ${gateReceipt.id.slice(0, 18)}…  tx ${txHash.slice(0, 18)}…`);
    console.log(`    BaseScan       ${basescanTxUrl(txHash)}`);
    if (agentReceipt.settlement?.txHash?.toLowerCase() !== txHash.toLowerCase()) {
      throw new Error('agent and gate receipts disagree on the settlement tx');
    }

    console.log('\n  Waiting for the on-chain indexer to reconcile (block + poll)…');
    const settled = await indexer.waitFor(
      (e) => e.type === 'payment.settled' && e.payment.txHash.toLowerCase() === txHash.toLowerCase(),
      120_000,
    );
    if (settled.type !== 'payment.settled') throw new Error('unreachable');
    const matches = settled.payment.intentId === agentReceipt.intentId;
    console.log(`  ✓ payment.settled  intent ${settled.payment.intentId}  block ${settled.payment.blockNumber}`);
    console.log(`    nonce-memo reconciliation: intent id ${matches ? 'MATCHES the receipt' : 'MISMATCH!'}`);
    if (!matches) throw new Error('indexer reconciled the wrong intent');

    // ── Scenario 3: replay (free — burned before the rails) ───────────────────
    console.log(section('Scenario 3  ·  Replay — burned before the facilitator ever sees it'));

    const replay = await fetch(`${vendor.url}/v1/report`, {
      headers: { 'X-PAYMENT': lastHeader },
    });
    console.log(`  ✗ REFUSED  HTTP ${replay.status} · ${lastRefusal()}`);
    console.log('\n  USDC would refuse this nonce on-chain anyway — but the gate refuses it');
    console.log('  at the door, so the replay costs the vendor zero facilitator round-trips.');

    // ── Summary ────────────────────────────────────────────────────────────────
    const stats = gate.stats();
    const revenue = Object.entries(stats.revenue)
      .map(([asset, amount]) => `$${amount} (${asset.slice(0, 10)}…)`)
      .join(', ');

    console.log('\n' + bar('═'));
    console.log('  Summary');
    console.log(bar('═'));
    console.log(`
  Gate:              ${stats.quoted} quoted · ${stats.settled} settled · ${stats.refused} refused
  Vendor revenue:    ${revenue} — real testnet USDC, on-chain
  Agent's books:     ${guard.receipts().length} guard receipt(s)
  Indexer:           ${indexer.settledPayments().length} payment.settled reconciled via nonce memo
  Decision log:      ${engine.decisions().length} entries  (ed25519-signed, sha256-chained)
  Elapsed:           ${((Date.now() - t0) / 1000).toFixed(1)}s
`);
    console.log('  The settlement is real — open the BaseScan link above.');
    console.log('\n' + bar('═'));
    console.log('  Done.\n');
  } finally {
    indexer.stop();
    await vendor.close();
    await app.close();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
