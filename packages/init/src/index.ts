import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createGuard, PaymentBlockedError, type Payer } from '@reinconsole/sdk';

/**
 * `npx @reinconsole/init`: a Rein sandbox in one command (Stage 4, Sprint 12).
 *
 * 1. generate a wallet on THIS machine (the private key never leaves it);
 * 2. `POST /v1/sandbox` on the hosted engine -- an org, an agent, a starter
 *    policy and a 7-day key, plus a drip of test USDC to that wallet;
 * 3. write everything to `rein-agent.json` -- the ONE file holding the
 *    secrets, never a command line (the S80 auto-mode lesson);
 * 4. one governed call that is allowed and settles, one that the policy
 *    refuses before any money moves;
 * 5. print the MCP config (pointing at the file) and an SDK snippet.
 *
 * Testnet only: the wallet, the drip and the guard are all Base Sepolia, and
 * the guard is bounded to that network, so nothing this writes can pay on the
 * real-money chain.
 */

export const DEFAULT_ENGINE_URL = 'https://engine.reinconsole.com';
export const DEFAULT_VENDOR_URL = 'https://vendor.reinconsole.com';
export const AGENT_FILE = 'rein-agent.json';
const NETWORK = 'base-sepolia';
/** The cheapest paid call on the reference vendor, and the one the starter policy allows. */
const PING_PATH = '/testnet/v1/ping';
/** $0.005 -- above the starter policy's $0.004 per-call cap, so it is refused. */
const DENIED_PATH = '/testnet/v1/scores/vendor/api.example.com';
/** Enough USDC (6 decimals) for the $0.001 ping. */
const MIN_BALANCE = 1_000n;

export interface AgentFile {
  engineUrl: string;
  orgId: string;
  agentId: string;
  apiKey: string;
  expiresAt: string;
  network: typeof NETWORK;
  wallet: { address: `0x${string}`; privateKey: `0x${string}` };
}

/** What init needs from the chain -- injected so tests never touch one. */
export interface InitChain {
  generateWallet(): { address: `0x${string}`; privateKey: `0x${string}` };
  /** USDC balance in atomic units (6 decimals). */
  balanceOf(address: `0x${string}`): Promise<bigint>;
  payerFor(privateKey: `0x${string}`): Payer;
  txUrl(txHash: string): string;
}

export interface InitOptions {
  dir?: string;
  engineUrl?: string;
  vendorUrl?: string;
  /** Mint a new sandbox even when rein-agent.json exists (it is overwritten). */
  force?: boolean;
  /** Stop after writing the file: no demo calls. */
  noDemo?: boolean;
  /** How long to wait for the drip to land. */
  balanceWaitMs?: number;
  pollMs?: number;
  fetch?: typeof globalThis.fetch;
  chain?: InitChain;
  log?: (line: string) => void;
}

export interface InitResult {
  file: string;
  agent: AgentFile;
  created: boolean;
  allowed?: 'settled' | 'unpaid' | 'failed';
  settlementTx?: string;
  denied?: string;
}

export class InitError extends Error {
  override readonly name = 'InitError';
}

export async function runInit(options: InitOptions = {}): Promise<InitResult> {
  const log = options.log ?? ((line: string) => console.log(line));
  const http = options.fetch ?? globalThis.fetch;
  const chain = options.chain ?? (await realChain());
  const dir = resolve(options.dir ?? process.cwd());
  const file = join(dir, AGENT_FILE);
  const engineUrl = (options.engineUrl ?? DEFAULT_ENGINE_URL).replace(/\/+$/, '');
  const vendorUrl = (options.vendorUrl ?? DEFAULT_VENDOR_URL).replace(/\/+$/, '');

  let agent: AgentFile;
  let created = false;
  let drip: { txHash?: string; amount?: string; error?: string } | undefined;
  if (existsSync(file) && !options.force) {
    agent = JSON.parse(readFileSync(file, 'utf8')) as AgentFile;
    log(`Using the existing ${AGENT_FILE} (agent ${agent.agentId}). Pass --force for a new sandbox.`);
  } else {
    const wallet = chain.generateWallet();
    log('Creating a sandbox on ' + engineUrl + ' ...');
    const res = await http(`${engineUrl}/v1/sandbox`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ wallet: wallet.address }),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.status !== 201) {
      throw new InitError(
        `the engine refused the sandbox (HTTP ${res.status}): ${String(body['message'] ?? body['error'] ?? 'no reason given')}`,
      );
    }
    agent = {
      engineUrl,
      orgId: String(body['orgId']),
      agentId: String(body['agentId']),
      apiKey: String(body['apiKey']),
      expiresAt: String(body['expiresAt']),
      network: NETWORK,
      wallet,
    };
    drip = body['drip'] as typeof drip;
    // 0600: the file holds a key that spends and a key that governs.
    writeFileSync(file, JSON.stringify(agent, null, 2) + '\n', { mode: 0o600 });
    created = true;
    protectFromGit(dir);
    log(`  agent   ${agent.agentId}`);
    log(`  wallet  ${agent.wallet.address} (key stays in ${AGENT_FILE}, on this machine)`);
    log(`  expires ${agent.expiresAt} unless you claim it`);
    if (drip?.txHash) log(`  drip    ${drip.amount} test USDC: ${chain.txUrl(drip.txHash)}`);
    else if (drip?.error) log(`  drip    none -- ${drip.error}`);
  }

  const result: InitResult = { file, agent, created };
  if (options.noDemo) {
    printNext(log, file, agent);
    return result;
  }

  // Wait for the drip: payments only switch on once the wallet can pay. A new
  // sandbox with no drip on its way gets one look, not a 90-second wait.
  const noDripComing = created && !drip?.txHash;
  const funded = await waitForBalance(chain, agent.wallet.address, {
    waitMs: noDripComing ? 0 : (options.balanceWaitMs ?? 90_000),
    pollMs: options.pollMs ?? 3_000,
    log,
  });
  const payer = funded ? chain.payerFor(agent.wallet.privateKey) : undefined;
  if (!funded) log('  The wallet has no test USDC yet, so this run decides but does not pay.');

  const guard = createGuard({
    engineUrl: agent.engineUrl,
    agentId: agent.agentId,
    apiKey: agent.apiKey,
    networks: [NETWORK],
    fetch: http,
    engineFetch: http,
    ...(payer ? { payer } : {}),
  });
  const governed = guard.wrap();

  log(`\n1. A $0.001 call your policy allows -- ${vendorUrl}${PING_PATH}`);
  try {
    const res = await governed(`${vendorUrl}${PING_PATH}`);
    const receipt = guard.receipts().at(-1);
    if (receipt?.outcome === 'allow' && receipt.settlement?.txHash) {
      result.allowed = 'settled';
      result.settlementTx = receipt.settlement.txHash;
      log(`   ALLOWED and PAID: ${chain.txUrl(receipt.settlement.txHash)}`);
    } else if (receipt?.outcome === 'allow') {
      result.allowed = 'unpaid';
      log(`   ALLOWED (decision ${receipt.decisionId ?? '?'}); not paid -- HTTP ${res.status}`);
    } else {
      result.allowed = 'failed';
      log(`   unexpected: HTTP ${res.status}, outcome ${receipt?.outcome ?? 'none'}`);
    }
  } catch (err) {
    result.allowed = 'failed';
    log(`   failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  log(`\n2. A $0.005 call over your $0.004 per-call cap -- ${vendorUrl}${DENIED_PATH}`);
  try {
    const res = await governed(`${vendorUrl}${DENIED_PATH}`);
    log(`   NOT refused (HTTP ${res.status}) -- check your policy`);
  } catch (err) {
    if (err instanceof PaymentBlockedError) {
      result.denied = err.decision.reason;
      log(`   DENIED before any money moved: ${err.decision.reason}`);
    } else {
      log(`   failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  printNext(log, file, agent);
  return result;
}

async function waitForBalance(
  chain: InitChain,
  address: `0x${string}`,
  opts: { waitMs: number; pollMs: number; log: (l: string) => void },
): Promise<boolean> {
  const deadline = Date.now() + opts.waitMs;
  let announced = false;
  for (;;) {
    try {
      if ((await chain.balanceOf(address)) >= MIN_BALANCE) return true;
    } catch {
      // An RPC hiccup is not an empty wallet; keep polling until the deadline.
    }
    if (Date.now() >= deadline) return false;
    if (!announced) {
      opts.log('  Waiting for the test USDC to land (a few seconds on Base Sepolia) ...');
      announced = true;
    }
    await new Promise((r) => setTimeout(r, opts.pollMs));
  }
}

/** Add rein-agent.json to an existing .gitignore -- the file holds two secrets. */
function protectFromGit(dir: string): void {
  const gitignore = join(dir, '.gitignore');
  if (!existsSync(gitignore)) return;
  const lines = readFileSync(gitignore, 'utf8').split(/\r?\n/);
  if (lines.some((l) => l.trim() === AGENT_FILE || l.trim() === `/${AGENT_FILE}`)) return;
  appendFileSync(gitignore, `${lines.at(-1) === '' ? '' : '\n'}${AGENT_FILE}\n`);
}

function printNext(log: (l: string) => void, file: string, agent: AgentFile): void {
  const mcp = {
    mcpServers: {
      rein: {
        command: 'npx',
        args: ['-y', '@reinconsole/mcp'],
        env: { REIN_AGENT_FILE: file },
      },
    },
  };
  log(`
Next: give your agent the same governed fetch.

  MCP (Claude Code, Cursor, ...) -- add to your MCP config:
${JSON.stringify(mcp, null, 2).replace(/^/gm, '    ')}

  SDK:
    import { readFileSync } from 'node:fs';
    import { createGuard } from '@reinconsole/sdk';
    import { createX402Payer } from '@reinconsole/x402-rails';
    const a = JSON.parse(readFileSync('${AGENT_FILE}', 'utf8'));
    const guard = createGuard({ engineUrl: a.engineUrl, agentId: a.agentId, apiKey: a.apiKey,
      networks: ['${NETWORK}'], payer: createX402Payer({ privateKey: a.wallet.privateKey }) });
    const fetch = guard.wrap();

  Your policy: GET ${agent.engineUrl}/v1/policies with the apiKey in ${AGENT_FILE}.
  This sandbox expires ${agent.expiresAt}. Keep ${AGENT_FILE} private -- it holds your keys.`);
}

async function realChain(): Promise<InitChain> {
  const rails = await import('@reinconsole/x402-rails');
  const profile = rails.PROFILES.testnet;
  const client = rails.createChainClient(profile);
  return {
    generateWallet: () => rails.generateWallet(),
    balanceOf: (address) => rails.getProfileUsdcBalance(client, address, profile),
    payerFor: (privateKey) =>
      rails.createX402Payer({ privateKey, networks: [NETWORK], profile }),
    txUrl: (txHash) => profile.explorerTxUrl(txHash),
  };
}
