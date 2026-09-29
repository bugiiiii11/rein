#!/usr/bin/env node
/**
 * Decision latency on a given store backend (Sprint 11.1: "measure decision
 * p95 before/after -- every evaluate now crosses the network").
 *
 * Times `engine.evaluateIntent` end to end, which is what an agent waits on:
 * policy evaluation, the signed append, AND the awaited insert into
 * `decisions` (plus the spend row). The decision's own `latencyMs` field
 * stops before the persist, so it would hide exactly the cost being measured.
 *
 *   node scripts/bench-decisions.mjs                       # PGlite, temp dir
 *   DATABASE_URL=postgres://... node scripts/bench-decisions.mjs   # network
 *
 * With DATABASE_URL it writes into a throwaway schema (`rein_bench_<ts>`) and
 * drops it afterwards -- never point it at the engine's own schema. Needs
 * `pnpm build`. N defaults to 300 (after 20 warm-up evaluations).
 */
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from '../services/store/node_modules/pg/lib/index.js';
import { openReinStore } from '../services/store/dist/index.js';
import { PolicyEngine } from '../services/policy-engine/dist/index.js';
import { newId } from '../packages/core/dist/index.js';

const N = Number(process.env.BENCH_N ?? 300);
const WARMUP = 20;
const url = process.env.DATABASE_URL || undefined;
const schema = `rein_bench_${Date.now()}`;
const dir = url ? undefined : mkdtempSync(join(tmpdir(), 'rein-bench-'));

const signingKey = generateKeyPairSync('ed25519')
  .privateKey.export({ type: 'pkcs8', format: 'pem' })
  .toString();
const agentId = newId('agt');
const store = await openReinStore(url ? { databaseUrl: url, schema, signingKey } : { dir, signingKey });

try {
  const engine = new PolicyEngine(store);
  // A realistic policy: a per-call cap and a rolling budget, so evaluation
  // reads the spend window rather than short-circuiting on an empty rule set.
  await engine.addPolicy({
    policyId: 'pol_bench',
    rules: [
      { id: 'cap', deny: { amountGt: '1.00' } },
      { id: 'daily', deny: { rollingSum: { window: '24h', gt: '1000.00' } } },
    ],
    default: 'allow',
  });
  const intent = () => ({
    agentId,
    vendor: { host: 'api.example.com', address: '0x1' },
    resource: '/v1/answer',
    amount: '0.01',
    asset: 'USDC',
    chain: 'base',
  });

  for (let i = 0; i < WARMUP; i += 1) await engine.evaluateIntent(intent());
  const samples = [];
  for (let i = 0; i < N; i += 1) {
    const start = performance.now();
    await engine.evaluateIntent(intent());
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  const q = (p) => samples[Math.min(samples.length - 1, Math.floor(p * samples.length))].toFixed(2);
  const where = url ? `postgres ${new URL(url).hostname}` : 'pglite (temp dir)';
  console.log(`[bench] ${where}: n=${N}  p50=${q(0.5)}ms  p95=${q(0.95)}ms  p99=${q(0.99)}ms  max=${q(1)}ms`);
} finally {
  await store.close();
  if (url) {
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await client.end();
  } else {
    rmSync(dir, { recursive: true, force: true });
  }
}
