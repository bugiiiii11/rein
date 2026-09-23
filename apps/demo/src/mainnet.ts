/**
 * Rein -- the mainnet runner (Sprint 7.2). One run, then exit:
 *   one call to Rein's own vendor + one call to a THIRD-PARTY x402 service
 *   found in PayAI's public catalog, both governed by a Rein engine.
 *
 * ADVISORY by default: the engine decides, the 402 comes back unpaid, nothing
 * is signed. `--pay` adds a payer, and then an on-chain indexer -- not the
 * guard -- is what tells the engine the payment landed, so reconciliation has
 * a reporter independent of the spender's own word.
 *
 *   pnpm --filter @reinconsole/demo build
 *   node apps/demo/dist/mainnet.js --local            # in-process engine, free
 *   node apps/demo/dist/mainnet.js                    # hosted engine, advisory
 *   node apps/demo/dist/mainnet.js --pay              # hosted engine, SPENDS
 *
 * The network is `REIN_NETWORK_PROFILE` (default testnet -- mainnet is always
 * asked for by name). Remote mode reads REIN_ENGINE_URL, REIN_RUNNER_AGENT_ID
 * and REIN_RUNNER_API_KEY (evaluate + read scopes). `--pay` needs
 * REIN_RUNNER_PRIVATE_KEY, whose address must be one of the agent's
 * registered wallets. Optional: REIN_RUNNER_RPC_URL, REIN_RUNNER_VENDOR_URL,
 * REIN_RUNNER_THIRD_PARTY_URL (skips the catalog), REIN_RUNNER_MAX_USDC
 * (per-call ceiling for catalog picks, default 0.05).
 *
 * On this machine every HTTPS call needs NODE_EXTRA_CA_CERTS=$HOME/.rein-dev-ca.pem.
 */

import type { AddressInfo } from 'node:net';
import type { Address, Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { newId, type Agent, type Receipt } from '@reinconsole/core';
import { PolicyEngine, buildServer } from '@reinconsole/policy-engine';
import {
  EngineClient,
  PaymentBlockedError,
  UnsupportedRequirementError,
  createGuard,
  decimalToAtomic,
  type Payer,
} from '@reinconsole/sdk';
import {
  OnchainIndexer,
  createChainClient,
  createX402Payer,
  discoverResources,
  generateWallet,
  type DiscoveredResource,
  type NetworkProfile,
} from '@reinconsole/x402-rails';
import { profileFromEnv, readEnv } from './env.js';

const VENDOR_HOST = 'vendor.reinconsole.com';
/** Candidates tried before the third-party leg is declared failed. */
const MAX_CANDIDATES = 5;

type Outcome =
  | { kind: 'allowed-unpaid'; receipt: Receipt }
  | { kind: 'paid'; receipt: Receipt; status: number; body: string }
  | { kind: 'blocked'; receipt: Receipt }
  | { kind: 'not-a-paywall'; status: number }
  | { kind: 'ungovernable'; reason: string }
  | { kind: 'error'; reason: string };

interface Leg {
  name: string;
  url: string;
  outcome: Outcome;
  pass: boolean;
  note: string;
}

function vendorUrl(profile: NetworkProfile): string {
  // The mainnet lane has the empty prefix; testnet lives under /testnet.
  return profile.name === 'mainnet'
    ? `https://${VENDOR_HOST}/v1/ping`
    : `https://${VENDOR_HOST}/testnet/v1/ping`;
}

async function main(): Promise<number> {
  const args = new Set(process.argv.slice(2));
  const pay = args.has('--pay');
  const local = args.has('--local');
  const profile = profileFromEnv();

  const privateKey = readEnv('REIN_RUNNER_PRIVATE_KEY') as Hex | undefined;
  if (pay && (privateKey === undefined || !/^0x[0-9a-fA-F]{64}$/.test(privateKey))) {
    throw new Error('--pay needs REIN_RUNNER_PRIVATE_KEY (0x + 64 hex characters)');
  }
  // Advisory mode needs an address for the agent record, never a key.
  const wallet: Address = privateKey
    ? privateKeyToAccount(privateKey).address
    : generateWallet().address;

  console.log(`\n  Rein mainnet runner  ·  profile ${profile.name} (${profile.network})`);
  console.log(`  mode ${pay ? 'PAY -- real settlement' : 'advisory -- nothing is signed'}`);
  console.log(`  engine ${local ? 'in-process (--local)' : 'remote'}`);

  // ── Engine ──────────────────────────────────────────────────────────────────
  let close: () => Promise<void> = async () => {};
  let engineUrl: string;
  let apiKey: string | undefined;
  let agent: Agent;

  if (local) {
    const engine = new PolicyEngine();
    const app = buildServer(engine);
    await app.listen({ port: 0, host: '127.0.0.1' });
    close = () => app.close();
    engineUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    agent = await engine.registerAgent({
      id: newId('agt'),
      orgId: newId('org'),
      name: 'mainnet-runner (local)',
      wallets: [{ chain: 'base', address: wallet, mode: 'sdk' }],
      status: 'active',
      createdAt: new Date(),
    });
    await new EngineClient({ baseUrl: engineUrl }).addPolicy({
      policyId: 'pol_runner_local',
      appliesTo: { agents: [agent.id] },
      rules: [{ id: 'tx-cap', deny: { amountGt: '0.05' } }],
      default: 'allow',
    });
  } else {
    engineUrl = need('REIN_ENGINE_URL');
    apiKey = need('REIN_RUNNER_API_KEY');
    const agentId = need('REIN_RUNNER_AGENT_ID');
    const found = (await new EngineClient({ baseUrl: engineUrl, apiKey }).listAgents()).find(
      (a) => a.id === agentId,
    );
    if (!found) throw new Error(`agent ${agentId} is not visible to this key on ${engineUrl}`);
    agent = found;
  }

  // A payment from a wallet the agent does not own is invisible to the
  // indexer -- it watches the agent's REGISTERED wallets -- so it could
  // never be reconciled and never be flagged. Refuse rather than spend blind.
  const owned = agent.wallets.some(
    (w) => w.chain === 'base' && w.address.toLowerCase() === wallet.toLowerCase(),
  );
  if (pay && !owned) {
    await close();
    throw new Error(
      `the payer ${wallet} is not a registered base wallet of ${agent.id}; ` +
        'a payment from it could never be reconciled',
    );
  }

  console.log(`  agent ${agent.id}  wallet ${wallet}${owned ? '' : '  (not registered)'}`);

  // ── Indexer (pay mode only: in advisory mode nothing moves) ─────────────────
  const chain = createChainClient(profile, readEnv('REIN_RUNNER_RPC_URL'));
  const indexer = pay
    ? new OnchainIndexer({
        client: chain,
        usdcAddress: profile.usdc,
        chain: 'base',
        agents: () => [agent],
        decimals: profile.decimals,
        onError: (err) => console.warn(`  (indexer RPC hiccup: ${String(err).slice(0, 80)})`),
      })
    : undefined;
  await indexer?.start();

  // The indexer must know an intent is allowed BEFORE its transfer can land,
  // or it scans our own payment as a shadow spend. The payer runs after the
  // allow and before the signature exists, so learning here cannot race.
  let payer: Payer | undefined;
  if (pay && indexer) {
    const sign = createX402Payer({ privateKey: privateKey!, networks: [profile.network] });
    payer = (requirement, intent, decision) => {
      indexer.learnAllowed({ id: intent.id, agentId: intent.agentId });
      return sign(requirement, intent, decision);
    };
  }

  const guard = createGuard({
    engineUrl,
    ...(apiKey ? { apiKey } : {}),
    agentId: agent.id,
    // The engine folds Base Sepolia into `base`, so this list is the only
    // thing stopping a testnet run from being allowed to pay a mainnet 402.
    networks: [profile.network, profile.caip2],
    ...(payer ? { payer } : {}),
    // The indexer reports; a guard vouching for its own payment is the weak
    // evidence reconciliation exists to check.
    reportSettlement: false,
  });
  const fetch = guard.wrap();

  async function call(url: string): Promise<Outcome> {
    const before = guard.receipts().length;
    try {
      const res = await fetch(url);
      const receipt = guard.receipts().length > before ? guard.receipts().at(-1) : undefined;
      if (!receipt) return { kind: 'not-a-paywall', status: res.status };
      if (!payer) return { kind: 'allowed-unpaid', receipt };
      // A rejected payment's body is the only account of why; keep a slice.
      const body = res.ok ? '' : (await res.text().catch(() => '')).slice(0, 200);
      return { kind: 'paid', receipt, status: res.status, body };
    } catch (err) {
      if (err instanceof PaymentBlockedError) return { kind: 'blocked', receipt: err.receipt };
      if (err instanceof UnsupportedRequirementError) {
        return { kind: 'ungovernable', reason: err.message };
      }
      return { kind: 'error', reason: err instanceof Error ? err.message : String(err) };
    }
  }

  const legs: Leg[] = [];
  try {
    // ── Leg 1: Rein's own vendor ──────────────────────────────────────────────
    const ownUrl = readEnv('REIN_RUNNER_VENDOR_URL') ?? vendorUrl(profile);
    const own = await call(ownUrl);
    // Until Sprint 8 arms it, the mainnet lane 404s by design.
    const unarmed = profile.name === 'mainnet' && own.kind === 'not-a-paywall' && own.status === 404;
    legs.push(judge('vendor', ownUrl, own, unarmed ? 'mainnet lane unarmed (expected before Sprint 8)' : undefined));

    // ── Leg 2: a third party from the catalog ─────────────────────────────────
    const override = readEnv('REIN_RUNNER_THIRD_PARTY_URL');
    const maxUsdc = readEnv('REIN_RUNNER_MAX_USDC') ?? '0.05';
    const candidates: Pick<DiscoveredResource, 'resource' | 'amount'>[] = override
      ? [{ resource: override, amount: 0n }]
      : await discoverResources({
          profile,
          maxAtomic: BigInt(decimalToAtomic(maxUsdc, profile.decimals)),
          excludeHosts: [VENDOR_HOST],
          want: MAX_CANDIDATES,
        });
    if (candidates.length === 0) {
      legs.push({
        name: 'third-party',
        url: '(none)',
        outcome: { kind: 'error', reason: 'catalog had no match' },
        pass: false,
        note: `no ${profile.network} USDC GET <= $${maxUsdc} in the PayAI catalog`,
      });
    }
    for (const [i, c] of candidates.slice(0, MAX_CANDIDATES).entries()) {
      const outcome = await call(c.resource);
      const leg = judge('third-party', c.resource, outcome);
      // A dead or non-paywalled catalog entry is the catalog's problem: try
      // the next one. Anything that produced a receipt was governed, and in
      // pay mode may have spent -- never try a second one after that.
      const governed = 'receipt' in outcome;
      if (governed || i === Math.min(candidates.length, MAX_CANDIDATES) - 1) {
        legs.push(leg);
        break;
      }
      console.log(`  skip ${c.resource}  (${describe(outcome)})`);
    }

    // ── Reconciliation from the chain (pay mode) ──────────────────────────────
    if (indexer) {
      const client = new EngineClient({ baseUrl: engineUrl, ...(apiKey ? { apiKey } : {}) });
      for (const leg of legs) {
        if (leg.outcome.kind !== 'paid' || leg.outcome.receipt.outcome !== 'allow') continue;
        const { receipt } = leg.outcome;
        // The chain is the judge either way -- a vendor can settle and still
        // answer an error -- but one that refused the payment and named no
        // transaction almost never moved money, so do not wait two minutes.
        const refused = leg.outcome.status >= 400 && !receipt.settlement?.txHash;
        try {
          const ev = await indexer.waitFor(
            (e) => e.type === 'payment.settled' && e.payment.intentId === receipt.intentId,
            refused ? 30_000 : 120_000,
          );
          if (ev.type !== 'payment.settled') throw new Error('unreachable');
          await client.reportSettlement({
            intentId: receipt.intentId,
            txHash: ev.payment.txHash,
            chain: ev.payment.chain,
            amount: receipt.amount,
            source: 'indexer',
            confirmedAt: ev.payment.confirmedAt,
          });
          leg.note = `indexed ${ev.payment.txHash} (block ${ev.payment.blockNumber}), reported to engine`;
          if (profile.explorerTxUrl) leg.note += `\n        ${profile.explorerTxUrl(ev.payment.txHash)}`;
        } catch (err) {
          leg.pass = false;
          leg.note =
            `${leg.note}; the indexer never saw it settle (${err instanceof Error ? err.message : String(err)})` +
            (refused ? ' -- the signed authorization stays redeemable until its validBefore' : '');
        }
      }
      const shadows = indexer.shadowSpends();
      if (shadows.length > 0) {
        legs.push({
          name: 'shadow',
          url: '(chain)',
          outcome: { kind: 'error', reason: 'shadow spend' },
          pass: false,
          note: shadows.map((s) => `$${s.amount} in ${s.txHash} with no ALLOW behind it`).join('; '),
        });
      }
    }
  } finally {
    indexer?.stop();
    await close();
  }

  console.log('');
  for (const leg of legs) {
    console.log(`  ${leg.pass ? 'PASS' : 'FAIL'}  ${leg.name.padEnd(11)} ${describe(leg.outcome)}`);
    console.log(`        ${leg.url}`);
    if (leg.note) console.log(`        ${leg.note}`);
  }
  const failed = legs.filter((l) => !l.pass).length;
  console.log(`\n  ${legs.length - failed}/${legs.length} passed\n`);
  return failed === 0 ? 0 : 1;

  function judge(name: string, url: string, outcome: Outcome, expected?: string): Leg {
    switch (outcome.kind) {
      case 'allowed-unpaid':
      case 'blocked':
        // Allow or deny, the engine reached a signed decision on a real 402:
        // that is what an advisory run proves.
        return { name, url, outcome, pass: true, note: `decision ${outcome.receipt.decisionId}` };
      case 'paid': {
        const settled = outcome.receipt.settlement?.txHash;
        return {
          name,
          url,
          outcome,
          pass: outcome.status < 400,
          note: settled
            ? `vendor reports ${settled}`
            : `vendor answered ${outcome.status}, no settlement header${outcome.body ? `: ${outcome.body}` : ''}`,
        };
      }
      case 'not-a-paywall':
        return { name, url, outcome, pass: expected !== undefined, note: expected ?? 'no 402 to govern' };
      default:
        return { name, url, outcome, pass: false, note: outcome.reason };
    }
  }
}

function describe(o: Outcome): string {
  switch (o.kind) {
    case 'allowed-unpaid':
      return `ALLOW $${o.receipt.amount}, released unpaid`;
    case 'paid':
      return `ALLOW $${o.receipt.amount}, paid -> HTTP ${o.status}`;
    case 'blocked':
      return `${o.receipt.outcome.toUpperCase()} $${o.receipt.amount}: ${o.receipt.reason ?? ''}`;
    case 'not-a-paywall':
      return `HTTP ${o.status}, no paywall`;
    default:
      return `${o.kind}: ${o.reason.slice(0, 120)}`;
  }
}

function need(name: string): string {
  const v = readEnv(name);
  if (!v) throw new Error(`missing ${name} (environment or repo-root .env)`);
  return v;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err);
    process.exit(1);
  },
);
