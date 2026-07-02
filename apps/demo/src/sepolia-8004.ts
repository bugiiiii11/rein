/**
 * Rein — REAL ERC-8004 registration on Base Sepolia.
 *
 * The same wallet that pays over x402 (demo:sepolia) gets an on-chain
 * identity: one `register(agentURI)` transaction against the ratified
 * ERC-8004 Identity Registry singleton, then the reputation graph keys the
 * agent by that identity — engine-side and gate-side evidence merge on link
 * facts read straight from the chain (ownerOf, the verified agentWallet).
 *
 * UNLIKE demo:sepolia this demo needs a little Base Sepolia ETH for gas (the
 * facilitator is not involved in registration). Registration happens ONCE:
 * the minted id is saved to .env as REIN_SEPOLIA_ERC8004_ID and every re-run
 * is read-only. Losing .env after registering orphans the registration
 * (a re-run mints a fresh identity — fine on testnet).
 *
 * The FEEDBACK beat (S19) publishes the graph's score for this agent to the
 * real Reputation Registry. The contract bans self-feedback (the owner cannot
 * score its own agent), so a separate counterparty wallet — persisted as
 * REIN_SEPOLIA_FEEDBACK_KEY, gas-funded once from the agent wallet — plays
 * the vendor operator. Also once: re-runs read the published entry back.
 *
 * Run (PowerShell — the CA var matters on machines with TLS interception):
 *   $env:NODE_EXTRA_CA_CERTS = "$HOME\.rein-dev-ca.pem"
 *   pnpm --filter @rein/demo demo:sepolia-8004
 */

import type { Hex } from 'viem';
import { createWalletClient, formatEther, http, parseEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { newId, parseErc8004Id, type Receipt, type ReinEvent } from '@rein/core';
import { ReputationGraph } from '@rein/graph';
import {
  BASE_SEPOLIA_REGISTRY,
  REIN_SCORE_TAG,
  getIdentityRegistryAddress,
  identityRegistryReader,
  lastFeedbackIndex,
  linkAgentFromRegistry,
  publishAgentScore,
  readFeedbackEntry,
  readSummary,
  registerAgent,
} from '@rein/erc8004';
import { basescanTxUrl, createBaseSepoliaClient, generateWallet } from '@rein/x402-rails';
import { appendEnv, readEnv } from './env.js';

const MIN_GAS_WEI = 100_000_000_000_000n; // 0.0001 ETH — register() costs a fraction of this
const GAS_FAUCETS = [
  'https://portal.cdp.coinbase.com/products/faucet   (Coinbase Developer Platform)',
  'https://www.alchemy.com/faucets/base-sepolia      (Alchemy)',
];
const DAY = 86_400_000;
const HOUR = 3_600_000;
const W = 64;

const bar = (c: string) => c.repeat(W);
const section = (label: string) => `\n${bar('─')}\n ${label}\n${bar('─')}`;

async function main() {
  console.log('\n' + bar('═'));
  console.log('  Rein  ·  ERC-8004 on Base Sepolia (the real registry)');
  console.log(bar('═'));

  // ── Wallet bootstrap (shared with demo:sepolia) ─────────────────────────────
  let privateKey = readEnv('REIN_SEPOLIA_PRIVATE_KEY') as Hex | undefined;
  if (privateKey === undefined) {
    const agent = generateWallet();
    // Also seed the vendor address demo:sepolia expects — without it a later
    // demo:sepolia run silently degrades to the agent paying itself.
    const vendorWallet = generateWallet();
    const path = appendEnv({
      REIN_SEPOLIA_PRIVATE_KEY: agent.privateKey,
      REIN_SEPOLIA_VENDOR_ADDRESS: vendorWallet.address,
    });
    console.log(`\n  Generated a fresh agent wallet and saved it to ${path}`);
    console.log(`  Agent wallet   ${agent.address}`);
    console.log(`  Vendor address ${vendorWallet.address}  (used by demo:sepolia)`);
    console.log(`\n  Next step: this demo registers an identity ON-CHAIN, so the wallet`);
    console.log(`  needs a little Base Sepolia ETH for gas (0.001 is plenty):`);
    for (const f of GAS_FAUCETS) console.log(`    ${f}`);
    console.log(`  Then re-run this demo.`);
    return;
  }

  const account = privateKeyToAccount(privateKey);
  const wallet = account.address;
  const rpcUrl = readEnv('REIN_SEPOLIA_RPC_URL');
  const publicClient = createBaseSepoliaClient(rpcUrl);
  const walletClient = createWalletClient({ account, chain: baseSepolia, transport: http(rpcUrl) });
  const reader = identityRegistryReader(publicClient);

  console.log(`\n  Agent wallet   ${wallet}`);
  console.log(`  Registry       ${BASE_SEPOLIA_REGISTRY.address} (chain ${BASE_SEPOLIA_REGISTRY.chainId})`);

  // ── Deployment cross-check: the registries vouch for each other ────────────
  const namedIdentity = await getIdentityRegistryAddress(publicClient);
  console.log(`  Cross-check    ReputationRegistry.getIdentityRegistry() -> ${namedIdentity}`);
  if (namedIdentity.toLowerCase() !== BASE_SEPOLIA_REGISTRY.address.toLowerCase()) {
    console.error('  MISMATCH — refusing to write against an unexpected deployment.');
    process.exit(1);
  }

  // ── Registration (once; re-runs resume from .env) ──────────────────────────
  let erc8004Id = readEnv('REIN_SEPOLIA_ERC8004_ID');
  const existing = erc8004Id !== undefined ? parseErc8004Id(erc8004Id) : undefined;
  // A PRESENT but unparseable id must be fatal, not a fall-through to the
  // registration branch: readEnv returns the FIRST match, so re-minting would
  // append a forever-shadowed second line and every run would mint again.
  if (erc8004Id !== undefined && existing === undefined) {
    console.error(`\n  REIN_SEPOLIA_ERC8004_ID is malformed: "${erc8004Id}"`);
    console.error(`  Fix or remove that .env line, then re-run.`);
    process.exit(1);
  }
  let freshlyMinted = false;

  if (existing) {
    console.log(section('Identity (resumed from .env — read-only run)'));
    const owner = await reader.ownerOf(existing.tokenId);
    if (owner.toLowerCase() !== wallet.toLowerCase()) {
      console.error(`  ${erc8004Id}`);
      console.error(`  is owned by ${owner}, not our wallet — remove REIN_SEPOLIA_ERC8004_ID`);
      console.error(`  from .env to register a fresh identity.`);
      process.exit(1);
    }
    console.log(`  ${erc8004Id}`);
    console.log(`  owner verified on-chain: ${owner}`);
  } else {
    console.log(section('Registering on the ERC-8004 Identity Registry'));

    // Gas gate — the ONE thing this demo needs that demo:sepolia does not.
    const gas = await publicClient.getBalance({ address: wallet });
    if (gas < MIN_GAS_WEI) {
      console.log(`  ETH balance: ${formatEther(gas)} — needs ~0.0001 for the register() tx.`);
      console.log(`\n  Fund ${wallet}`);
      console.log(`  with Base Sepolia ETH (0.001 is plenty), then re-run:`);
      for (const f of GAS_FAUCETS) console.log(`    ${f}`);
      return;
    }
    console.log(`  ETH for gas    ${formatEther(gas)}`);

    // Minimal registration-v1 file as a self-contained data: URI — no hosting,
    // read back verbatim from tokenURI. (No self-referencing `registrations[]`:
    // the agentId does not exist before the mint; setAgentURI could add it.)
    const registrationFile = {
      type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
      name: 'rein-sepolia-agent',
      description: 'Rein demo agent — x402 payments governed by the Rein control plane.',
      x402Support: true,
      active: true,
    };
    const agentURI = `data:application/json;base64,${Buffer.from(
      JSON.stringify(registrationFile),
    ).toString('base64')}`;

    const t0 = Date.now();
    const minted = await registerAgent({ publicClient, walletClient, agentURI });
    erc8004Id = minted.erc8004Id;
    freshlyMinted = true;
    const path = appendEnv({ REIN_SEPOLIA_ERC8004_ID: erc8004Id });

    console.log(`  registered in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    console.log(`  agentId        ${minted.tokenId}`);
    console.log(`  erc8004Id      ${erc8004Id}  (saved to ${path})`);
    console.log(`  tx             ${basescanTxUrl(minted.txHash)}`);
  }

  const ref = parseErc8004Id(erc8004Id!)!;

  // ── Read-back: the chain's view of our identity ─────────────────────────────
  console.log(section('On-chain identity facts (read back live)'));
  // Right after the mint, a load-balanced public RPC can serve reads from a
  // node that has not seen the receipt's block yet (ownerOf briefly reverts
  // ERC721NonexistentToken). Give propagation a few seconds — verified live:
  // the very first run hit exactly this.
  const ownerOfMinted = async (): Promise<string> => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await reader.ownerOf(ref.tokenId);
      } catch (err) {
        const lagging = freshlyMinted && (err as { code?: string }).code === 'unknown_agent';
        if (!lagging || attempt >= 5) throw err;
        console.log(`  (rpc still propagating the mint — retry ${attempt}/5)`);
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  };
  const owner = await ownerOfMinted();
  const agentWallet = await reader.agentWallet(ref.tokenId);
  const uri = await reader.agentURI(ref.tokenId);
  console.log(`  ownerOf        ${owner}`);
  console.log(`  agentWallet    ${agentWallet}  (auto-set to the owner at registration)`);
  console.log(`  agentURI       ${uri.slice(0, 58)}…`);
  console.log(`  NFT            https://sepolia.basescan.org/nft/${BASE_SEPOLIA_REGISTRY.address}/${ref.tokenId}`);

  // ── The reputation beat: two id spaces merge on chain facts ─────────────────
  console.log(section('Reputation: the identity is the party'));

  const graph = new ReputationGraph();
  const ulid = newId('agt'); // how a Rein engine would key this same party
  const start = Date.now() - 14 * DAY;

  // Engine-side history (guard receipts, ULID-keyed)...
  for (let i = 0; i < 5; i += 1) {
    const at = new Date(start + i * 6 * HOUR);
    const receipt: Receipt = {
      id: newId('rcp'),
      agentId: ulid,
      intentId: newId('int'),
      decisionId: newId('dec'),
      outcome: 'allow',
      url: 'https://api.data.example/v1/query',
      method: 'GET',
      vendorHost: 'api.data.example',
      amount: '0.05',
      asset: 'USDC',
      chain: 'base',
      taskContext: {},
      settlement: { txHash: `0x5e7${i}` },
      createdAt: at,
    };
    graph.ingestReceipt(receipt);
  }
  // ...gate-side history (vendor receipts, keyed by our REAL wallet).
  for (let i = 0; i < 3; i += 1) {
    const at = new Date(start + i * 9 * HOUR);
    const settled: ReinEvent = {
      type: 'gate.settled',
      at,
      receipt: {
        id: newId('grc'),
        at,
        route: '/api/*',
        resource: '/api/answer',
        method: 'GET',
        payer: wallet,
        payTo: '0x7e57000000000000000000000000000000000001',
        amount: '0.05',
        amountAtomic: '50000',
        asset: 'USDC',
        network: 'base-sepolia',
        transaction: `0x9a7e${i}`,
      },
    };
    graph.ingest(settled);
  }

  console.log(`  before linking: ${graph.scores('agent').length} agent rows (ULID space + wallet space)`);

  // Same fresh-mint propagation caveat as ownerOfMinted: a lagging node makes
  // linkAgentFromRegistry take its LENIENT local fallback (that is the right
  // library behavior for a world boot — but here it would quietly contradict
  // the demo's thesis), so retry until the on-chain facts resolve.
  let linked = await linkAgentFromRegistry(graph, reader, {
    id: ulid,
    erc8004Id: erc8004Id!,
    wallets: [{ address: wallet }],
  });
  for (let attempt = 1; freshlyMinted && linked.source === 'local' && attempt <= 5; attempt += 1) {
    console.log(`  (rpc still propagating the mint — link retry ${attempt}/5)`);
    await new Promise((r) => setTimeout(r, 3000));
    linked = await linkAgentFromRegistry(graph, reader, {
      id: ulid,
      erc8004Id: erc8004Id!,
      wallets: [{ address: wallet }],
    });
  }

  const merged = graph.explain(linked.canonical);
  console.log(`  linked via     ${linked.source} (${linked.pairs} aliases, facts read from Base Sepolia)`);
  console.log(`  after linking: ${graph.scores('agent').length} agent row, keyed by the ON-CHAIN identity:`);
  console.log(`    ${linked.canonical.id}`);
  console.log(
    `    ${merged!.evidence.attempts} attempts · ${merged!.evidence.settled} settled · $${merged!.evidence.volume} — 5 engine-side + 3 gate-side, one party`,
  );

  // ── Feedback: the score goes on the REAL chain ─────────────────────────────
  console.log(section('Feedback: publishing the score to the Reputation Registry'));

  if (linked.source !== 'erc8004') {
    console.log('  (identity facts did not resolve on-chain this run — skipping the');
    console.log('   feedback beat; re-run once the RPC has caught up)');
  } else {
    // The contract bans self-feedback (owner/operator), so a separate
    // counterparty wallet plays the vendor operator — generated once,
    // persisted, and gas-funded from the agent wallet on first use.
    let feedbackKey = readEnv('REIN_SEPOLIA_FEEDBACK_KEY') as Hex | undefined;
    if (feedbackKey === undefined) {
      const fresh = generateWallet();
      feedbackKey = fresh.privateKey;
      const path = appendEnv({ REIN_SEPOLIA_FEEDBACK_KEY: feedbackKey });
      console.log(`  generated counterparty (feedback) wallet ${fresh.address}`);
      console.log(`  saved to ${path}`);
    }
    const feedbackAccount = privateKeyToAccount(feedbackKey);
    const already = await lastFeedbackIndex(publicClient, {
      agentId: ref.tokenId,
      clientAddress: feedbackAccount.address,
    });

    if (already > 0n) {
      console.log(`  resumed: this counterparty already published ${already} entr${already === 1n ? 'y' : 'ies'} — read-only run`);
      const stored = await readFeedbackEntry(publicClient, {
        agentId: ref.tokenId,
        clientAddress: feedbackAccount.address,
        index: already,
      });
      console.log(`  readFeedback   value ${stored.value}/100 · tags ${stored.tag1}/${stored.tag2} · revoked ${stored.revoked}`);
    } else {
      // Gas: giveFeedback with a ~450-byte evidence URI costs a fraction of
      // 0.0001 ETH; fund the counterparty once from the agent wallet.
      const FEEDBACK_FUND = parseEther('0.0002');
      const feedbackGas = await publicClient.getBalance({ address: feedbackAccount.address });
      if (feedbackGas < FEEDBACK_FUND / 2n) {
        const mainGas = await publicClient.getBalance({ address: wallet });
        if (mainGas < FEEDBACK_FUND * 2n) {
          console.log(`  agent wallet has ${formatEther(mainGas)} ETH — not enough to fund the`);
          console.log(`  counterparty (${formatEther(FEEDBACK_FUND)} needed). Top up and re-run:`);
          for (const f of GAS_FAUCETS) console.log(`    ${f}`);
          console.log('  (identity + reputation beats above all succeeded — only feedback skipped)\n');
          return;
        }
        console.log(`  funding counterparty with ${formatEther(FEEDBACK_FUND)} ETH from the agent wallet…`);
        const fundTx = await walletClient.sendTransaction({
          to: feedbackAccount.address,
          value: FEEDBACK_FUND,
        });
        await publicClient.waitForTransactionReceipt({ hash: fundTx });
        console.log(`  funded         ${basescanTxUrl(fundTx)}`);
      }

      const score = graph.score(linked.canonical)!;
      const feedbackWallet = createWalletClient({
        account: feedbackAccount,
        chain: baseSepolia,
        transport: http(rpcUrl),
      });
      const t1 = Date.now();
      const { published, evidenceUri } = await publishAgentScore({
        publicClient,
        walletClient: feedbackWallet,
        score,
        identity: BASE_SEPOLIA_REGISTRY,
      });
      console.log(`  published in ${((Date.now() - t1) / 1000).toFixed(1)}s`);
      console.log(`  giveFeedback   agentId ${published.agentId} · score ${score.score}/100 · index ${published.feedbackIndex}`);
      console.log(`  tx             ${basescanTxUrl(published.txHash)}`);
      console.log(`  evidence       ${evidenceUri.slice(0, 56)}… (keccak-anchored on-chain)`);
    }

    // Read the aggregate back from the REAL contract (with the same fresh-write
    // propagation tolerance as the mint read-backs).
    let summary = await readSummary(publicClient, { agentId: ref.tokenId, tag1: REIN_SCORE_TAG });
    for (let attempt = 1; summary.count === 0n && attempt <= 5; attempt += 1) {
      console.log(`  (rpc still propagating the feedback — retry ${attempt}/5)`);
      await new Promise((r) => setTimeout(r, 3000));
      summary = await readSummary(publicClient, { agentId: ref.tokenId, tag1: REIN_SCORE_TAG });
    }
    console.log(`  getSummary     ${summary.value}/100 across ${summary.count} ${REIN_SCORE_TAG} entr${summary.count === 1n ? 'y' : 'ies'}`);
    console.log('\n  This agent now has PUBLIC, on-chain reputation: any x402 vendor can');
    console.log(`  read getSummary(${ref.tokenId}, [], "${REIN_SCORE_TAG}", "") before serving it.`);
  }

  console.log(section('Summary'));
  console.log('  The registry is the source of link facts: ownerOf and the verified');
  console.log('  agentWallet came from the chain, not from local configuration. Any');
  console.log('  Rein deployment that reads the same registry keys this agent the');
  console.log('  same way — reputation that follows the identity, not the install.');
  console.log('  The graph\'s judgment is published back to the chain as feedback —');
  console.log('  scores that follow the identity too, readable by anyone.');
  console.log(`\n  Re-runs are read-only (ids + keys live in .env). Gas was spent once.\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
