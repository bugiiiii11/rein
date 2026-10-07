import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { canonicalApproval } from '@reinconsole/core';
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
  /** Absent once the org is claimed and moved to mainnet (`init --mainnet`). */
  expiresAt?: string;
  network: typeof NETWORK | 'base';
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
  if (options.force && existsSync(file) && readAgentFile(file).network === 'base') {
    // --force overwrites the file, and a mainnet file holds the only copy of a
    // wallet key that may hold real USDC.
    throw new InitError(
      `${AGENT_FILE} is on Base mainnet and holds your wallet's only key -- move it somewhere safe before creating a new sandbox here`,
    );
  }
  if (existsSync(file) && !options.force) {
    agent = readAgentFile(file);
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
  if (agent.network === 'base') {
    // The demo pays the testnet vendor from a testnet wallet; a mainnet file
    // has neither any more, and a first-run demo is no reason to spend.
    log(`${AGENT_FILE} is on Base mainnet; the demo is testnet only.`);
    printMainnet(log, file, agent, ownerFilePath(agent.orgId));
    return result;
  }
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

export const DEFAULT_CONSOLE_URL = 'https://app.reinconsole.com';

export interface ClaimOptions {
  dir?: string;
  consoleUrl?: string;
  fetch?: typeof globalThis.fetch;
  /** Opens the claim page; defaults to the platform's browser opener. Return false if it could not. */
  open?: (url: string) => boolean;
  log?: (line: string) => void;
  /** How long to wait for the sign-in before returning; 0 = print the link and return. Default 10 minutes. */
  waitMs?: number;
  pollMs?: number;
}

/**
 * `init --claim` (Sprint 13.2): ask the engine for a one-time claim code with
 * the sandbox's own key, then send the browser to the console to sign in and
 * keep the org. The key never leaves this machine -- only the code, which is
 * good for ten minutes and one use, rides in the URL.
 */
export async function runClaim(
  options: ClaimOptions = {},
): Promise<{ url: string; orgId: string; claimed: boolean }> {
  const log = options.log ?? ((line: string) => console.log(line));
  const http = options.fetch ?? globalThis.fetch;
  const { agent } = agentFileIn(options.dir);
  const res = await http(`${agent.engineUrl.replace(/\/+$/, '')}/v1/claims`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${agent.apiKey}` },
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (res.status !== 201) {
    throw new InitError(
      `the engine refused the claim (HTTP ${res.status}): ${String(body['message'] ?? body['error'] ?? 'no reason given')}`,
    );
  }
  const consoleUrl = (options.consoleUrl ?? DEFAULT_CONSOLE_URL).replace(/\/+$/, '');
  const url = `${consoleUrl}/claim?code=${encodeURIComponent(String(body['code']))}`;
  const opened = (options.open ?? openBrowser)(url);
  log(`${opened ? 'Opened' : 'Open'} this link to sign in and keep org ${String(body['orgId'])} (valid 10 minutes, one use):`);
  log(`  ${url}`);
  // Then wait for the sign-in: the claim is an `owner:` key in the org's key
  // list, which the sandbox key can read. Without this the terminal's last
  // word was the link, and a tester had to infer success from the dashboard.
  const waitMs = options.waitMs ?? CLAIM_WAIT_MS;
  const pollMs = options.pollMs ?? CLAIM_POLL_MS;
  const deadline = Date.now() + waitMs;
  let claimed = false;
  if (waitMs > 0) log('Waiting for the sign-in (Ctrl+C to stop waiting; the link stays valid)...');
  while (Date.now() < deadline) {
    const keys = await engineCall(http, agent.engineUrl, 'GET', '/v1/keys', agent.apiKey);
    const list = keys.status === 200 && Array.isArray(keys.body) ? (keys.body as { name: string; revokedAt?: string }[]) : [];
    const owner = list.find((k) => k.name.startsWith('owner:') && !k.revokedAt);
    if (owner) {
      claimed = true;
      log(`Claimed: org ${String(body['orgId'])} is yours (signed in as ${owner.name.slice('owner:'.length)}).`);
      log('Its keys no longer expire. Next: `npx @reinconsole/init --mainnet` in this folder to pay with real USDC.');
      break;
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  if (!claimed && waitMs > 0) {
    log('Not claimed yet. Finish the sign-in in the browser; the dashboard will say "Your org" once it is done.');
  }
  return { url, orgId: String(body['orgId']), claimed };
}

/** How long `--claim` waits for the sign-in: the code's own lifetime. */
const CLAIM_WAIT_MS = 10 * 60_000;
const CLAIM_POLL_MS = 3_000;

function openBrowser(url: string): boolean {
  // Spawned with an argument vector, never a shell string: the URL is data.
  const [cmd, args] =
    process.platform === 'win32'
      ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => undefined);
    child.unref();
    return true;
  } catch {
    return false;
  }
}

function readAgentFile(file: string): AgentFile {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as AgentFile;
  } catch (err) {
    throw new InitError(`${file} is not readable JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function agentFileIn(dir: string | undefined): { file: string; agent: AgentFile } {
  const file = join(resolve(dir ?? process.cwd()), AGENT_FILE);
  if (!existsSync(file)) {
    throw new InitError(`no ${AGENT_FILE} here -- run \`npx @reinconsole/init\` first, in the folder you want the agent in`);
  }
  return { file, agent: readAgentFile(file) };
}

/** One JSON call to the engine. A network failure is an InitError; a refusal is the caller's to word. */
async function engineCall(
  http: typeof globalThis.fetch,
  engineUrl: string,
  method: 'GET' | 'POST',
  path: string,
  apiKey: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  let res: Response;
  try {
    res = await http(`${engineUrl.replace(/\/+$/, '')}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch (err) {
    throw new InitError(`${method} ${path} did not reach ${engineUrl}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

function field(body: unknown, name: string): unknown {
  return body && typeof body === 'object' ? (body as Record<string, unknown>)[name] : undefined;
}

function refused(what: string, res: { status: number; body: unknown }): InitError {
  const reason = field(res.body, 'message') ?? field(res.body, 'error') ?? 'no reason given';
  return new InitError(`the engine refused ${what} (HTTP ${res.status}): ${String(reason)}`);
}

/**
 * The OWNER's credentials for a mainnet org, kept apart from `rein-agent.json`
 * (the file the agent and its MCP server read): the org-wide admin key, which
 * can rewrite the policy, and the approver's private key, which signs "yes" to
 * an escalation. An agent that could use either could loosen its own limits or
 * approve its own escalations -- the A2 rule is that an approval is a
 * signature by someone other than the spender.
 */
export interface OwnerFile {
  engineUrl: string;
  orgId: string;
  adminKey: string;
  approver: { keyId?: string; privateKeyPem: string };
}

export const DEFAULT_OWNER_DIR = join(homedir(), '.rein');

export function ownerFilePath(orgId: string, ownerDir: string = DEFAULT_OWNER_DIR): string {
  return join(ownerDir, `owner-${orgId}.json`);
}

function readOwnerFile(path: string): OwnerFile {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as OwnerFile;
  } catch (err) {
    throw new InitError(`${path} is not readable JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function readJson<T>(path: string): T {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch (err) {
    throw new InitError(`${path} is not readable JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function writePending(path: string, pending: MainnetPending): void {
  writeFileSync(path, JSON.stringify(pending, null, 2) + '\n', { mode: 0o600 });
}

function writeOwnerFile(path: string, owner: OwnerFile): void {
  writeFileSync(path, JSON.stringify(owner, null, 2) + '\n', { mode: 0o600 });
}

export interface MainnetOptions {
  dir?: string;
  /** Where the owner's credentials go (default `~/.rein`). */
  ownerDir?: string;
  fetch?: typeof globalThis.fetch;
  /** The mainnet agent's fresh wallet; injected so tests never touch a chain. */
  generateWallet?: InitChain['generateWallet'];
  log?: (line: string) => void;
}

/** The sandbox's file, kept beside the new one: its testnet wallet key exists nowhere else. */
export const TESTNET_AGENT_FILE = 'rein-agent.base-sepolia.json';
/**
 * A mainnet move in progress: the fresh wallet and what has been registered
 * for it so far. Written BEFORE the wallet is registered, so an interrupted run
 * resumes with the same wallet and agent instead of minting a second of each.
 */
const MAINNET_PENDING_FILE = 'rein-agent.mainnet-pending.json';
interface MainnetPending {
  orgId: string;
  wallet: AgentFile['wallet'];
  agentId?: string;
  policyIds?: string[];
}

export interface MainnetResult {
  file: string;
  ownerFile: string;
  agent: AgentFile;
  /** False when the file was already on mainnet and nothing was done. */
  changed: boolean;
}

/**
 * `init --mainnet` (Sprint 13.4): move a CLAIMED org's agent to Base mainnet.
 *
 * 1. refuse unless the org is claimed -- an `owner:` key in its own key list
 *    and no sandbox key still expiring (claiming is what lifts the expiry);
 * 2. write the owner file FIRST, with the admin key and a fresh ed25519
 *    approver key, so a failure below can never leave a registered approver
 *    nobody can sign for, or an admin key that exists nowhere;
 * 3. register the approver's public half (`POST /v1/approvers`);
 * 4. generate a FRESH wallet, register a new mainnet agent in the same org
 *    with it, and copy every policy that governed the sandbox agent onto it;
 * 5. mint that agent a runtime key -- this agent only, `evaluate` + `read`: it
 *    spends within the policy and reads its own receipts, and cannot change
 *    the policy, mint keys or sign an approval;
 * 6. keep the sandbox file as `rein-agent.base-sepolia.json` and rewrite
 *    `rein-agent.json` for the new agent, its wallet and `network: 'base'`.
 *
 * A fresh wallet (founder decision, S103) rather than the sandbox's: the
 * testnet key has sat in a file through a whole sandbox run and may have been
 * shared or pasted while experimenting, and real USDC deserves a key that never
 * was. A new AGENT rather than the same agent with a new wallet, because the
 * engine screens the wallets an org's agents REGISTERED when the mainnet key is
 * minted (screening.ts) and has no route to add one to an existing agent --
 * registering it is what puts the mainnet wallet in front of the screen.
 *
 * The engine does not know which chain a payment is on (an intent says `base`
 * for both), so "claimed orgs only" is this check plus the 7-day expiry on
 * every unclaimed key -- not an engine-side network rule.
 */
export async function runMainnet(options: MainnetOptions = {}): Promise<MainnetResult> {
  const log = options.log ?? ((line: string) => console.log(line));
  const http = options.fetch ?? globalThis.fetch;
  const { file, agent } = agentFileIn(options.dir);
  const ownerDir = options.ownerDir ?? DEFAULT_OWNER_DIR;
  const ownerFile = ownerFilePath(agent.orgId, ownerDir);

  if (agent.network === 'base') {
    log(`${AGENT_FILE} is already on Base mainnet.`);
    printMainnet(log, file, agent, ownerFile);
    return { file, ownerFile, agent, changed: false };
  }

  const keys = await engineCall(http, agent.engineUrl, 'GET', '/v1/keys', agent.apiKey);
  if (keys.status === 401) {
    throw new InitError(
      `the engine no longer accepts the key in ${AGENT_FILE} -- an unclaimed sandbox expires after 7 days; \`npx @reinconsole/init --force\` starts a new one`,
    );
  }
  if (keys.status !== 200 || !Array.isArray(keys.body)) throw refused('the key list', keys);
  const list = keys.body as { name: string; expiresAt?: string; revokedAt?: string }[];
  const owned = list.some((k) => k.name.startsWith('owner:') && !k.revokedAt);
  const expiring = list.some((k) => k.name === 'sandbox' && !k.revokedAt && k.expiresAt);
  if (!owned || expiring) {
    throw new InitError(
      'mainnet needs a claimed org: run `npx @reinconsole/init --claim`, sign in, then run --mainnet again',
    );
  }

  let owner: OwnerFile;
  if (existsSync(ownerFile)) {
    // An earlier run got this far and stopped: resume with ITS approver key
    // rather than registering a second authority over this org's escalations.
    owner = readOwnerFile(ownerFile);
    if (owner.orgId !== agent.orgId) {
      throw new InitError(`${ownerFile} belongs to org ${owner.orgId}, not ${agent.orgId}`);
    }
  } else {
    const { privateKey } = generateKeyPairSync('ed25519');
    owner = {
      engineUrl: agent.engineUrl,
      orgId: agent.orgId,
      adminKey: agent.apiKey,
      approver: { privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() },
    };
    mkdirSync(ownerDir, { recursive: true, mode: 0o700 });
    writeOwnerFile(ownerFile, owner);
  }

  if (!owner.approver.keyId) {
    const publicKey = createPublicKey(owner.approver.privateKeyPem)
      .export({ type: 'spki', format: 'pem' })
      .toString();
    const registered = await engineCall(http, agent.engineUrl, 'POST', '/v1/approvers', owner.adminKey, {
      name: 'owner',
      publicKey,
    });
    const id = field(registered.body, 'id');
    if (registered.status !== 201 || typeof id !== 'string') throw refused('the approver key', registered);
    owner.approver.keyId = id;
    writeOwnerFile(ownerFile, owner);
  }

  const pendingFile = join(dirname(file), MAINNET_PENDING_FILE);
  let pending: MainnetPending;
  if (existsSync(pendingFile)) {
    pending = readJson<MainnetPending>(pendingFile);
    if (pending.orgId !== agent.orgId) {
      throw new InitError(`${pendingFile} belongs to org ${pending.orgId}, not ${agent.orgId}`);
    }
  } else {
    const generate = options.generateWallet ?? (await import('@reinconsole/x402-rails')).generateWallet;
    pending = { orgId: agent.orgId, wallet: generate() };
    writePending(pendingFile, pending);
  }

  if (!pending.agentId) {
    const registered = await engineCall(http, agent.engineUrl, 'POST', '/v1/agents', owner.adminKey, {
      name: 'mainnet',
      wallets: [{ chain: 'base', address: pending.wallet.address, mode: 'sdk' }],
    });
    const id = field(registered.body, 'id');
    if (registered.status !== 200 || typeof id !== 'string') throw refused('the mainnet agent', registered);
    pending.agentId = id;
    writePending(pendingFile, pending);
  }
  const agentId = pending.agentId;

  if (!pending.policyIds) {
    const listed = await engineCall(http, agent.engineUrl, 'GET', '/v1/policies', owner.adminKey);
    if (listed.status !== 200 || !Array.isArray(listed.body)) throw refused('the policy list', listed);
    type Listed = { policyId: string; orgId?: string; appliesTo?: { agents?: string[] } };
    const governing = (listed.body as Listed[]).filter((p) => p.appliesTo?.agents?.includes(agent.agentId));
    const policyIds: string[] = [];
    for (const { orgId: _org, ...policy } of governing) {
      const suffix = policyIds.length ? `_${policyIds.length}` : '';
      const copy = {
        ...policy,
        policyId: `pol_mainnet_${agentId.slice(4).toLowerCase()}${suffix}`,
        appliesTo: { ...policy.appliesTo, agents: [agentId] },
      };
      const added = await engineCall(http, agent.engineUrl, 'POST', '/v1/policies', owner.adminKey, copy);
      if (added.status !== 200) throw refused('the mainnet policy', added);
      policyIds.push(copy.policyId);
    }
    pending.policyIds = policyIds;
    writePending(pendingFile, pending);
  }

  // `mainnet: true` is what the engine gates (ServerOptions.mainnetOrgs): on
  // the hosted engine a new org is refused until it has been screened -- and
  // the screen covers the wallet registered above.
  const runtime = await engineCall(http, agent.engineUrl, 'POST', '/v1/keys', owner.adminKey, {
    name: 'mainnet-runtime',
    scopes: ['evaluate', 'read'],
    agentIds: [agentId],
    mainnet: true,
  });
  if (runtime.status === 403 && field(runtime.body, 'error') === 'mainnet_not_enabled') {
    throw new InitError(
      `${String(field(runtime.body, 'message'))}
${AGENT_FILE} stays on Base Sepolia; run --mainnet again once the org is enabled.`,
    );
  }
  const secret = field(runtime.body, 'secret');
  if (runtime.status !== 201 || typeof secret !== 'string') throw refused('the runtime key', runtime);

  const { expiresAt: _claimed, ...kept } = agent;
  const next: AgentFile = { ...kept, agentId, apiKey: secret, network: 'base', wallet: pending.wallet };
  // The sandbox file first: it is the only copy of the testnet wallet key.
  writeFileSync(join(dirname(file), TESTNET_AGENT_FILE), JSON.stringify(agent, null, 2) + '\n', { mode: 0o600 });
  writeFileSync(file, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  rmSync(pendingFile, { force: true });
  log(`${AGENT_FILE} is now on Base mainnet.`);
  printMainnet(log, file, next, ownerFile);
  return { file, ownerFile, agent: next, changed: true };
}

function printMainnet(log: (l: string) => void, file: string, agent: AgentFile, ownerFile: string): void {
  log(`
  ${file}
    network base; its key spends and reads for agent ${agent.agentId} only, from a
    NEW wallet made for mainnet (the sandbox file is kept as ${TESTNET_AGENT_FILE})
  ${ownerFile}
    YOUR keys: the org admin key (changes the policy) and the approver key (signs
    approvals). Keep this file where your agent cannot read it, and back it up --
    it is the only copy.

Fund the agent: send USDC on Base to ${agent.wallet.address}. The agent pays
from that wallet; Rein never holds the money. Start with a few dollars.

The policy still allows at most $0.004 per call and $0.05 per 24 hours, now in
real USDC. Change it with POST ${agent.engineUrl}/v1/policies and the adminKey in
the owner file.

Restart your MCP server so it picks up the new key and network. To answer an
escalation: npx @reinconsole/init --approve <decisionId>  (or --reject)`);
}

export interface ApproveOptions {
  decisionId: string;
  verdict: 'approve' | 'reject';
  /** Sign and submit. Without it the request is shown and nothing is signed. */
  yes?: boolean;
  dir?: string;
  ownerDir?: string;
  fetch?: typeof globalThis.fetch;
  log?: (line: string) => void;
}

interface ParkedRequest {
  decisionId: string;
  intentHash: string;
  status: string;
  expiresAt: string;
  amount: string;
  asset: string;
  chain: string;
  vendorHost?: string;
  resource?: string;
  reason: string;
  finalDecisionId?: string;
}

/**
 * `init --approve <decisionId>` / `--reject`: answer a parked escalation with
 * the approver key `--mainnet` registered. It shows the engine's own record of
 * the payment first and signs only with `--yes`: what a person signs must be
 * what they read, not a chat message about it.
 *
 * The signed bytes come from `canonicalApproval` in `@reinconsole/core`, the
 * function the engine verifies with, and must equal the challenge the engine
 * derived for this request. A mismatch is refused, not signed, because a
 * drifted signature fails exactly like a forged one.
 */
export async function runApprove(options: ApproveOptions): Promise<{ status: string; signed: boolean }> {
  const log = options.log ?? ((line: string) => console.log(line));
  const http = options.fetch ?? globalThis.fetch;
  const { agent } = agentFileIn(options.dir);
  const ownerFile = ownerFilePath(agent.orgId, options.ownerDir ?? DEFAULT_OWNER_DIR);
  if (!existsSync(ownerFile)) {
    throw new InitError(`no owner file at ${ownerFile} -- \`npx @reinconsole/init --mainnet\` registers the approver`);
  }
  const owner = readOwnerFile(ownerFile);
  const keyId = owner.approver.keyId;
  if (!keyId) throw new InitError(`${ownerFile} has no registered approver -- run --mainnet again`);

  const path = `/v1/approvals/${encodeURIComponent(options.decisionId)}`;
  const got = await engineCall(http, owner.engineUrl, 'GET', path, owner.adminKey);
  if (got.status === 404) throw new InitError(`no escalation ${options.decisionId} in org ${owner.orgId}`);
  const request = field(got.body, 'request') as ParkedRequest | undefined;
  if (got.status !== 200 || !request) throw refused('the escalation', got);
  const challenges = field(got.body, 'challenges') as Record<string, string> | undefined;

  const msLeft = new Date(request.expiresAt).getTime() - Date.now();
  const to = /^https?:\/\//.test(request.resource ?? '')
    ? request.resource
    : `${request.vendorHost ?? ''}${request.resource ?? ''}`;
  log(`escalation ${request.decisionId}`);
  log(`  status   ${request.status}${msLeft > 0 ? ` (${Math.ceil(msLeft / 60_000)} min left)` : ' (expired)'}`);
  log(`  payment  ${request.amount} ${request.asset} on ${request.chain}`);
  log(`  to       ${to}`);
  log(`  reason   ${request.reason}`);

  if (request.status !== 'pending') {
    throw new InitError(
      `already ${request.status}${request.finalDecisionId ? ` (decision ${request.finalDecisionId})` : ''}; nothing to sign`,
    );
  }
  if (msLeft <= 0) throw new InitError('the escalation has expired: the engine denies it, and a signature now changes nothing');

  const message = canonicalApproval({
    decisionId: request.decisionId,
    intentHash: request.intentHash,
    verdict: options.verdict,
  });
  if (challenges?.[options.verdict] !== message) {
    throw new InitError('the engine asks for different bytes than this version signs -- update @reinconsole/init; nothing was signed');
  }
  if (!options.yes) {
    log(`\nRe-run with --yes to sign "${options.verdict}" and submit it.`);
    return { status: request.status, signed: false };
  }

  const signature = sign(null, Buffer.from(message), createPrivateKey(owner.approver.privateKeyPem)).toString('base64');
  const resolved = await engineCall(http, owner.engineUrl, 'POST', `${path}/resolve`, owner.adminKey, {
    intentHash: request.intentHash,
    verdict: options.verdict,
    approverKeyId: keyId,
    signature,
  });
  const after = field(resolved.body, 'request') as { status: string } | undefined;
  const decision = field(resolved.body, 'decision') as { id: string; outcome: string } | undefined;
  if (resolved.status !== 200 || !after || !decision) throw refused('the signature', resolved);
  log(`\n${options.verdict === 'approve' ? 'Approved' : 'Rejected'}: ${after.status}, decision ${decision.id} (${decision.outcome})`);
  return { status: after.status, signed: true };
}
