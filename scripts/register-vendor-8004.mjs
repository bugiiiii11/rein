#!/usr/bin/env node
// Register the reference vendor (vendor.reinconsole.com) on the ERC-8004
// Identity Registry on BASE SEPOLIA. Sprint 14.2; testnet only by decision
// (2026-10-06): a mainnet identity waits until the vendor may legally charge.
//
//   node scripts/register-vendor-8004.mjs          # simulate only, nothing sent
//   node scripts/register-vendor-8004.mjs --send   # mint + self-reference, 2 txs
//
// Signs with REIN_SEPOLIA_PRIVATE_KEY from .env (the demo wallet that already
// owns the demo agent, #7393) and saves the new id to .env as
// REIN_SEPOLIA_VENDOR_ERC8004_ID. A saved id makes the script refuse to run
// again: a second run would mint a SECOND identity. Needs `pnpm build` and,
// on this box, NODE_EXTRA_CA_CERTS=$HOME/.rein-dev-ca.pem.

import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import {
  BASE_SEPOLIA_REGISTRY,
  identityRegistryAbi,
  registerAgent,
  registrationRef,
  setAgentUri,
} from '../services/erc8004/dist/index.js';
import { createBaseSepoliaClient } from '../services/x402-rails/dist/index.js';

// viem is not hoisted to the root; borrow the erc8004 package's copy.
const require = createRequire(new URL('../services/erc8004/package.json', import.meta.url));
const { createWalletClient, http, formatEther } = require('viem');
const { privateKeyToAccount } = require('viem/accounts');
const { baseSepolia } = require('viem/chains');

const ENV_FILE = new URL('../.env', import.meta.url);
const env = Object.fromEntries(
  (existsSync(ENV_FILE) ? readFileSync(ENV_FILE, 'utf8') : '')
    .split(/\r?\n/)
    .filter((l) => /^[A-Z0-9_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]),
);
const send = process.argv.includes('--send');

if (env.REIN_SEPOLIA_VENDOR_ERC8004_ID) {
  console.error(`Already registered: ${env.REIN_SEPOLIA_VENDOR_ERC8004_ID}. Refusing to mint a second identity.`);
  process.exit(1);
}
if (!env.REIN_SEPOLIA_PRIVATE_KEY) {
  console.error('REIN_SEPOLIA_PRIVATE_KEY missing from .env');
  process.exit(1);
}

const registrationFile = {
  type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
  name: 'Rein reference vendor',
  description:
    'Reference x402 vendor for Rein, the control plane for AI agent payments. Testnet lane: ' +
    'paid endpoints on Base Sepolia, protected by @reinconsole/gate.',
  services: [
    { name: 'web', endpoint: 'https://vendor.reinconsole.com' },
    { name: 'x402', endpoint: 'https://vendor.reinconsole.com/testnet/v1/ping' },
  ],
  x402Support: true,
  active: true,
};
const dataUri = (file) => `data:application/json;base64,${Buffer.from(JSON.stringify(file)).toString('base64')}`;

const account = privateKeyToAccount(env.REIN_SEPOLIA_PRIVATE_KEY);
const publicClient = createBaseSepoliaClient();
const walletClient = createWalletClient({ account, chain: baseSepolia, transport: http() });

const gas = await publicClient.getBalance({ address: account.address });
console.log(`registry  ${BASE_SEPOLIA_REGISTRY.address} (Base Sepolia)`);
console.log(`owner     ${account.address}  ETH ${formatEther(gas)}`);
console.log(`file      ${JSON.stringify(registrationFile)}`);

if (!send) {
  await publicClient.simulateContract({
    address: BASE_SEPOLIA_REGISTRY.address,
    abi: identityRegistryAbi,
    functionName: 'register',
    args: [dataUri(registrationFile)],
    account,
  });
  console.log('\nSimulation OK. Nothing sent. Re-run with --send to register.');
  process.exit(0);
}

const minted = await registerAgent({ publicClient, walletClient, agentURI: dataUri(registrationFile) });
// Persist BEFORE anything else can fail: losing the id orphans the identity.
appendFileSync(ENV_FILE, `\nREIN_SEPOLIA_VENDOR_ERC8004_ID=${minted.erc8004Id}\n`);
console.log(`\nregistered  ${minted.erc8004Id}  (saved to .env)`);
console.log(`tx          https://sepolia.basescan.org/tx/${minted.txHash}`);

// The spec's registrations[] self-reference needs the id, so it rides a second
// tx. Retry: an RPC that has not seen the mint's block reverts the simulate.
for (let attempt = 1; ; attempt += 1) {
  try {
    const updated = await setAgentUri({
      publicClient,
      walletClient,
      tokenId: minted.tokenId,
      agentURI: dataUri({ ...registrationFile, registrations: [registrationRef(minted.tokenId)] }),
    });
    console.log(`self-ref    https://sepolia.basescan.org/tx/${updated.txHash}`);
    break;
  } catch (err) {
    if (attempt >= 5) throw err;
    await new Promise((r) => setTimeout(r, 3000));
  }
}
