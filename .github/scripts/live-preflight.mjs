#!/usr/bin/env node
/**
 * Fail the live run in ten seconds with "fund the wallet" rather than in
 * twenty minutes with a facilitator error that means the same thing.
 *
 * An empty wallet is by far the most likely reason a live run goes red, and
 * it is an operator task, not a code defect -- so it must not look like one.
 * Every other outcome here (no key, no network, an RPC that will not answer)
 * is also a reason not to start spending, and says so by name.
 *
 * Imported from the BUILT package by path rather than by specifier: this
 * script runs from the repo root, where the workspace package is not a
 * dependency, and `pnpm build` has already run by the time CI calls it.
 */
import { fileURLToPath } from 'node:url';

const RAILS = new URL('../../services/x402-rails/dist/index.js', import.meta.url);

/** Enough for several $0.01 settlements plus headroom, in atomic USDC. */
const MINIMUM_ATOMIC = 100_000n; // 0.10 USDC

function fail(message) {
  console.error(`[live-preflight] ${message}`);
  process.exit(1);
}

const privateKey = process.env.REIN_SEPOLIA_PRIVATE_KEY;
if (!privateKey) {
  fail('REIN_SEPOLIA_PRIVATE_KEY is not set — add it to the repository secrets.');
}
if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
  fail('REIN_SEPOLIA_PRIVATE_KEY is not a 0x-prefixed 32-byte hex key.');
}

let rails;
try {
  rails = await import(RAILS.href);
} catch (cause) {
  fail(
    `could not load ${fileURLToPath(RAILS)} — run \`pnpm build\` before this script (${String(cause)})`,
  );
}

const { TESTNET, addressForPrivateKey, createChainClient, getProfileUsdcBalance } = rails;

const address = addressForPrivateKey(privateKey);
const client = createChainClient(TESTNET, process.env.REIN_SEPOLIA_RPC_URL);

let balance;
try {
  balance = await getProfileUsdcBalance(client, address, TESTNET);
} catch (cause) {
  fail(
    `could not read the USDC balance of ${address} on ${TESTNET.network} — ` +
      `the RPC may be rate-limiting (set REIN_SEPOLIA_RPC_URL to a keyed endpoint): ${String(cause)}`,
  );
}

const human = (atomic) => (Number(atomic) / 10 ** TESTNET.decimals).toFixed(6);

if (balance < MINIMUM_ATOMIC) {
  fail(
    `wallet ${address} holds ${human(balance)} USDC on ${TESTNET.network}, ` +
      `below the ${human(MINIMUM_ATOMIC)} needed to run the live suites.\n` +
      `Fund it at ${TESTNET.faucetUrl} and re-run.`,
  );
}

console.log(
  `[live-preflight] ${address} holds ${human(balance)} USDC on ${TESTNET.network} — proceeding.`,
);
