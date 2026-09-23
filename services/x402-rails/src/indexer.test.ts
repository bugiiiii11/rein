import { describe, it, expect, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Address, Hex } from 'viem';
import { newId } from '@reinconsole/core';
import { PolicyEngine, buildServer } from '@reinconsole/policy-engine';
import { EngineClient } from '@reinconsole/sdk';
import { OnchainIndexer, type ChainReader, type OnchainIndexerOptions, type RailLog } from './indexer.js';
import { intentNonce } from './nonce.js';

const WALLET: Address = '0x1111111111111111111111111111111111111111';
const PAY_TO: Address = '0x2222222222222222222222222222222222222222';
const OTHER: Address = '0x3333333333333333333333333333333333333333';

const closables: { close(): Promise<unknown> }[] = [];
afterEach(async () => {
  await Promise.all(closables.splice(0).map((c) => c.close()));
});

/** A controllable chain: logs are "mined" one block at a time. */
function fakeChain() {
  let head = 0n;
  const logs: RailLog[] = [];
  const reader: ChainReader = {
    getBlockNumber: () => Promise.resolve(head),
    getLogs: ({ fromBlock, toBlock }) =>
      Promise.resolve(
        logs.filter((l) => l.blockNumber !== null && l.blockNumber >= fromBlock && l.blockNumber <= toBlock),
      ),
  };
  const mine = (...newLogs: RailLog[]) => {
    head += 1n;
    for (const log of newLogs) logs.push({ ...log, blockNumber: head });
  };
  return { reader, mine };
}

const transfer = (tx: string, from: Address, to: Address, value: bigint): RailLog => ({
  eventName: 'Transfer',
  transactionHash: tx as Hex,
  blockNumber: null,
  args: { from, to, value },
});

const authorizationUsed = (tx: string, authorizer: Address, nonce: Hex): RailLog => ({
  eventName: 'AuthorizationUsed',
  transactionHash: tx as Hex,
  blockNumber: null,
  args: { authorizer, nonce },
});

const TX1 = `0x${'a1'.repeat(32)}`;
const TX2 = `0x${'a2'.repeat(32)}`;

/** Real engine over HTTP + the indexer wired to a fake chain. */
async function rig() {
  const engine = new PolicyEngine();
  const app = buildServer(engine);
  await app.listen({ port: 0, host: '127.0.0.1' });
  closables.push(app);
  const client = new EngineClient({
    baseUrl: `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`,
  });

  const agentId = newId('agt');
  await engine.registerAgent({
    id: agentId,
    orgId: newId('org'),
    name: 'indexed-agent',
    wallets: [{ chain: 'base', address: WALLET, mode: 'sdk' }],
    status: 'active',
    createdAt: new Date(),
  });
  await client.addPolicy({
    policyId: 'pol_allow',
    appliesTo: { agents: [agentId] },
    rules: [{ id: 'hard-cap', deny: { amountGt: '1.00' } }],
    default: 'allow',
  });

  const chain = fakeChain();
  const indexer = new OnchainIndexer({
    client: chain.reader,
    agents: () => engine.agents.list(),
    facilitator: 'x402.org',
    fromBlock: 1n,
    pollIntervalMs: 60_000, // ticks are driven manually via scan()
  });
  indexer.connectEngine(engine);
  await indexer.start();
  indexer.stop();

  const allowedIntent = async (amount = '0.01') => {
    const { intent, decision } = await client.evaluate({
      agentId,
      vendor: { host: 'api.vendor.test', address: PAY_TO },
      resource: '/v1/answer',
      amount,
      asset: 'USDC',
      chain: 'base',
    });
    expect(decision.outcome).toBe('allow');
    return intent;
  };

  return { engine, client, agentId, chain, indexer, allowedIntent };
}

describe('OnchainIndexer', () => {
  it('reconciles a settlement whose AuthorizationUsed nonce matches an allowed intent', async () => {
    const world = await rig();
    const intent = await world.allowedIntent();

    world.chain.mine(
      transfer(TX1, WALLET, PAY_TO, 10_000n),
      authorizationUsed(TX1, WALLET, intentNonce(intent.id)),
    );
    await world.indexer.scan();

    expect(world.indexer.shadowSpends()).toHaveLength(0);
    expect(world.indexer.settledPayments()).toEqual([
      expect.objectContaining({
        intentId: intent.id,
        txHash: TX1,
        chain: 'base',
        blockNumber: 1n,
        facilitator: 'x402.org',
      }),
    ]);
  });

  it('matches addresses case-insensitively (checksummed vs lowercase)', async () => {
    const world = await rig();
    const intent = await world.allowedIntent();
    const upper = WALLET.toUpperCase().replace('0X', '0x') as Address;

    world.chain.mine(
      transfer(TX1, upper, PAY_TO, 10_000n),
      authorizationUsed(TX1, upper, intentNonce(intent.id)),
    );
    await world.indexer.scan();

    expect(world.indexer.settledPayments()).toHaveLength(1);
  });

  it('flags a transfer with no AuthorizationUsed behind it as shadow.spend', async () => {
    const world = await rig();

    world.chain.mine(transfer(TX1, WALLET, OTHER, 2_500_000n));
    await world.indexer.scan();

    expect(world.indexer.settledPayments()).toHaveLength(0);
    expect(world.indexer.shadowSpends()).toEqual([
      expect.objectContaining({ agentId: world.agentId, txHash: TX1, amount: '2.5' }),
    ]);
  });

  it('flags an unknown nonce (no ALLOW decision behind it) as shadow.spend', async () => {
    const world = await rig();

    world.chain.mine(
      transfer(TX1, WALLET, PAY_TO, 10_000n),
      authorizationUsed(TX1, WALLET, intentNonce(newId('int'))),
    );
    await world.indexer.scan();

    expect(world.indexer.settledPayments()).toHaveLength(0);
    expect(world.indexer.shadowSpends()).toHaveLength(1);
  });

  it('flags a replayed nonce as shadow.spend (never reconciles twice)', async () => {
    const world = await rig();
    const intent = await world.allowedIntent();
    const nonce = intentNonce(intent.id);

    world.chain.mine(transfer(TX1, WALLET, PAY_TO, 10_000n), authorizationUsed(TX1, WALLET, nonce));
    world.chain.mine(transfer(TX2, WALLET, PAY_TO, 10_000n), authorizationUsed(TX2, WALLET, nonce));
    await world.indexer.scan();

    expect(world.indexer.settledPayments()).toHaveLength(1);
    expect(world.indexer.shadowSpends()).toEqual([expect.objectContaining({ txHash: TX2 })]);
  });

  it('ignores transfers from wallets Rein does not manage', async () => {
    const world = await rig();

    world.chain.mine(transfer(TX1, OTHER, PAY_TO, 10_000n));
    await world.indexer.scan();

    expect(world.indexer.events()).toHaveLength(0);
  });

  it('scans each block range exactly once across ticks', async () => {
    const world = await rig();
    const intent = await world.allowedIntent();

    world.chain.mine(
      transfer(TX1, WALLET, PAY_TO, 10_000n),
      authorizationUsed(TX1, WALLET, intentNonce(intent.id)),
    );
    await world.indexer.scan();
    await world.indexer.scan(); // nothing new — must not re-emit

    expect(world.indexer.events()).toHaveLength(1);
  });
});

/**
 * The remote seam. A runner pointed at a hosted engine has no in-process bus
 * to subscribe to, so `connectEngine` cannot reach it and the indexer starts
 * knowing nothing -- which classifies every genuine settlement as a shadow
 * spend. These drive `learnAllowed` directly: no engine, no HTTP, just the
 * two facts a remote reader can actually supply.
 */
describe('OnchainIndexer.learnAllowed (the remote seam)', () => {
  const AGENT_A = newId('agt');
  const AGENT_B = newId('agt');

  /** Two managed agents, two wallets, a fake chain. No policy engine. */
  function remoteRig() {
    const chain = fakeChain();
    const agents = [
      { id: AGENT_A, wallets: [{ chain: 'base', address: WALLET }] },
      { id: AGENT_B, wallets: [{ chain: 'base', address: OTHER }] },
    ];
    const indexer = new OnchainIndexer({
      client: chain.reader,
      // The indexer reads only id + wallets; the full Agent record is the
      // engine's business and a remote directory need not reproduce it.
      agents: () => agents as unknown as ReturnType<OnchainIndexerOptions['agents']>,
      facilitator: 'x402.org',
      fromBlock: 1n,
      pollIntervalMs: 60_000,
    });
    return { chain, indexer };
  }

  it('reconciles an intent learned without an in-process engine', async () => {
    const { chain, indexer } = remoteRig();
    await indexer.start();
    indexer.stop();
    const intentId = newId('int');

    indexer.learnAllowed({ id: intentId, agentId: AGENT_A });
    chain.mine(
      transfer(TX1, WALLET, PAY_TO, 10_000n),
      authorizationUsed(TX1, WALLET, intentNonce(intentId)),
    );
    await indexer.scan();

    expect(indexer.shadowSpends()).toHaveLength(0);
    expect(indexer.settledPayments()).toEqual([
      expect.objectContaining({ intentId, txHash: TX1, facilitator: 'x402.org' }),
    ]);
  });

  it('without the seam the same settlement is a false shadow spend', async () => {
    // The bug this exists to prevent, stated as a test: an indexer that was
    // never told anything reports a legitimate, authorized payment as an
    // alarm. This is what a remote runner got before `learnAllowed`.
    const { chain, indexer } = remoteRig();
    await indexer.start();
    indexer.stop();
    const intentId = newId('int');

    chain.mine(
      transfer(TX1, WALLET, PAY_TO, 10_000n),
      authorizationUsed(TX1, WALLET, intentNonce(intentId)),
    );
    await indexer.scan();

    expect(indexer.settledPayments()).toHaveLength(0);
    expect(indexer.shadowSpends()).toHaveLength(1);
  });

  it('will not credit one agent a payment made from another agent wallet', async () => {
    // The reason AllowedIntent carries agentId at all. B signs an EIP-3009
    // authorization whose nonce derives from A's allowed intent and spends
    // its OWN money. If the indexer matched on nonce alone it would call this
    // A's settlement: A's reconciliation gap closes on a payment A never
    // made, and B's unauthorized spend stops being a shadow spend. The nonce
    // is the memo, but the memo is not the authority.
    const { chain, indexer } = remoteRig();
    await indexer.start();
    indexer.stop();
    const intentId = newId('int');

    indexer.learnAllowed({ id: intentId, agentId: AGENT_A });
    chain.mine(
      transfer(TX1, OTHER, PAY_TO, 10_000n),
      authorizationUsed(TX1, OTHER, intentNonce(intentId)),
    );
    await indexer.scan();

    expect(indexer.settledPayments()).toHaveLength(0);
    expect(indexer.shadowSpends()).toEqual([
      expect.objectContaining({ agentId: AGENT_B, txHash: TX1 }),
    ]);
  });

  it('is idempotent, and a re-learn cannot resurrect a settled intent', async () => {
    // A paged feed re-reading its last row, or a poll overlapping the bus.
    const { chain, indexer } = remoteRig();
    await indexer.start();
    indexer.stop();
    const intentId = newId('int');

    indexer.learnAllowed({ id: intentId, agentId: AGENT_A });
    indexer.learnAllowed({ id: intentId, agentId: AGENT_A });
    expect(indexer.allowedIntentIds()).toEqual([intentId]);

    chain.mine(
      transfer(TX1, WALLET, PAY_TO, 10_000n),
      authorizationUsed(TX1, WALLET, intentNonce(intentId)),
    );
    await indexer.scan();
    expect(indexer.settledPayments()).toHaveLength(1);

    // Learning it again after settlement, then seeing a SECOND transfer reuse
    // the nonce: the replay is a shadow spend, not a second settlement.
    indexer.learnAllowed({ id: intentId, agentId: AGENT_A });
    chain.mine(
      transfer(TX2, WALLET, PAY_TO, 10_000n),
      authorizationUsed(TX2, WALLET, intentNonce(intentId)),
    );
    await indexer.scan();

    expect(indexer.settledPayments()).toHaveLength(1);
    expect(indexer.shadowSpends()).toEqual([expect.objectContaining({ txHash: TX2 })]);
  });
});
