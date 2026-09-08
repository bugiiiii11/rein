import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { newId, type ApprovalVerdict, type ReinEvent } from '@reinconsole/core';
import { PolicyEngine } from './engine.js';
import { ApprovalService, signApproval } from './approvals.js';
import { verifyDecisionChain } from './decision-log.js';

/**
 * The A2 end-to-end path: policy escalates, the engine parks the payment, a
 * signature (or the TTL) converts it into a real allow/deny on the chain.
 */

function baseIntent(agentId: string, amount: string) {
  return {
    agentId,
    vendor: { host: 'api.example.com', address: '0x1' },
    resource: '/v1/answer',
    amount,
    asset: 'USDC' as const,
    chain: 'base' as const,
  };
}

async function escalatingEngine(options: { ttlMs?: number; now?: () => number } = {}) {
  const approvals = new ApprovalService(options);
  const engine = new PolicyEngine({ approvals });
  await engine.addPolicy({
    policyId: 'pol_review',
    rules: [{ id: 'big-ticket', escalate: { amountGt: '10.00' } }],
    default: 'allow',
  });
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const approver = await approvals.registerApprover({
    orgId: newId('org'),
    name: 'Finance',
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  });
  return { engine, approvals, approver, privateKey };
}

function grantFor(
  request: { decisionId: string; intentHash: string },
  approverKeyId: string,
  privateKey: KeyObject,
  verdict: ApprovalVerdict,
) {
  return {
    decisionId: request.decisionId,
    intentHash: request.intentHash,
    verdict,
    approverKeyId,
    signature: signApproval(privateKey, {
      decisionId: request.decisionId,
      intentHash: request.intentHash,
      verdict,
    }),
  };
}

describe('escalation with signed approvals', () => {
  it('parks an escalated intent instead of just blocking it', async () => {
    const { engine } = await escalatingEngine();
    const events: ReinEvent[] = [];
    engine.onEvent((e) => events.push(e));

    const { decision, approval } = await engine.evaluateIntent(baseIntent(newId('agt'), '50.00'));

    expect(decision.outcome).toBe('escalate');
    expect(approval?.decisionId).toBe(decision.id);
    expect(approval?.status).toBe('pending');
    expect(approval?.intentHash).toBe(decision.intentHash);
    expect(events.map((e) => e.type)).toContain('approval.requested');
  });

  it('leaves escalate a hard block when no approval service is configured', async () => {
    const engine = new PolicyEngine();
    await engine.addPolicy({
      policyId: 'pol_review',
      rules: [{ id: 'big-ticket', escalate: { amountGt: '10.00' } }],
      default: 'allow',
    });

    const out = await engine.evaluateIntent(baseIntent(newId('agt'), '50.00'));
    expect(out.decision.outcome).toBe('escalate');
    // Nothing parked means nothing can release it — the SDK blocks, full stop.
    expect(out.approval).toBeUndefined();
    await expect(
      engine.resolveEscalation({
        decisionId: out.decision.id,
        intentHash: out.decision.intentHash,
        verdict: 'approve',
        approverKeyId: newId('apk'),
        signature: 'x',
      }),
    ).rejects.toThrow(/no approval service/);
  });

  it('converts a signed approval into an allow decision on the same intent', async () => {
    const { engine, approver, privateKey } = await escalatingEngine();
    const { intent, decision, approval } = await engine.evaluateIntent(
      baseIntent(newId('agt'), '50.00'),
    );

    const { request, decision: final } = await engine.resolveEscalation(
      grantFor(approval!, approver.id, privateKey, 'approve'),
    );

    expect(final.outcome).toBe('allow');
    // Same intent, same hash: the {intent, decision} pair a signer verifies
    // offline still commits to exactly this transfer.
    expect(final.intentId).toBe(intent.id);
    expect(final.intentHash).toBe(decision.intentHash);
    expect(final.matchedRules).toEqual([`approver:${approver.id}`]);
    expect(final.reason).toContain('approved by Finance');
    expect(request.status).toBe('approved');
    expect(request.finalDecisionId).toBe(final.id);
  });

  it('never rewrites the escalating decision — the chain only grows', async () => {
    const { engine, approver, privateKey } = await escalatingEngine();
    const { decision, approval } = await engine.evaluateIntent(baseIntent(newId('agt'), '50.00'));
    await engine.resolveEscalation(grantFor(approval!, approver.id, privateKey, 'approve'));

    const chain = engine.decisions();
    expect(chain).toHaveLength(2);
    expect(chain[0]?.id).toBe(decision.id);
    expect(chain[0]?.outcome).toBe('escalate'); // untouched
    expect(chain[1]?.outcome).toBe('allow');
    expect(verifyDecisionChain(chain, engine.publicKeyPem)).toBe(true);
  });

  it('counts an approved payment against the budget', async () => {
    const approvals = new ApprovalService();
    const engine = new PolicyEngine({ approvals });
    await engine.addPolicy({
      policyId: 'pol_review',
      rules: [
        { id: 'daily', deny: { rollingSum: { window: '24h', gt: '60.00' } } },
        { id: 'big-ticket', escalate: { amountGt: '10.00' } },
      ],
      default: 'allow',
    });
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const approver = await approvals.registerApprover({
      orgId: newId('org'),
      name: 'Finance',
      publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    });

    const agentId = newId('agt');
    const first = await engine.evaluateIntent(baseIntent(agentId, '50.00'));
    await engine.resolveEscalation(grantFor(first.approval!, approver.id, privateKey, 'approve'));

    // The approved 50.00 is now spent: a 20.00 follow-up breaches the 60.00
    // daily cap. An approval that did not record spend would let it through.
    const second = await engine.evaluateIntent(baseIntent(agentId, '20.00'));
    expect(second.decision.outcome).toBe('deny');
    expect(second.decision.matchedRules).toContain('daily');
  });

  it('converts a signed rejection into a deny, and records no spend', async () => {
    const { engine, approver, privateKey } = await escalatingEngine();
    const agentId = newId('agt');
    const { approval } = await engine.evaluateIntent(baseIntent(agentId, '50.00'));

    const { request, decision } = await engine.resolveEscalation(
      grantFor(approval!, approver.id, privateKey, 'reject'),
    );
    expect(decision.outcome).toBe('deny');
    expect(request.status).toBe('rejected');

    // Nothing was spent, so a small payment still passes.
    const after = await engine.evaluateIntent(baseIntent(agentId, '1.00'));
    expect(after.decision.outcome).toBe('allow');
  });

  it('denies an unanswered escalation when its TTL lapses (fail closed)', async () => {
    let now = 1_700_000_000_000;
    const { engine } = await escalatingEngine({ ttlMs: 60_000, now: () => now });
    const events: ReinEvent[] = [];
    engine.onEvent((e) => events.push(e));
    const { approval } = await engine.evaluateIntent(baseIntent(newId('agt'), '50.00'));

    expect(await engine.sweepEscalations()).toHaveLength(0); // still answerable
    now += 60_001;

    const swept = await engine.sweepEscalations();
    expect(swept).toHaveLength(1);
    expect(swept[0]?.request.status).toBe('expired');
    expect(swept[0]?.request.decisionId).toBe(approval?.decisionId);
    expect(swept[0]?.decision.outcome).toBe('deny');
    expect(swept[0]?.decision.matchedRules).toEqual(['escalation-expired']);
    expect(events.filter((e) => e.type === 'approval.resolved')).toHaveLength(1);

    // The sweep is idempotent: a settled request is never swept twice.
    expect(await engine.sweepEscalations()).toHaveLength(0);
  });

  it('lets only the first of two racing verdicts win', async () => {
    const { engine, approver, privateKey } = await escalatingEngine();
    const { approval } = await engine.evaluateIntent(baseIntent(newId('agt'), '50.00'));

    const results = await Promise.allSettled([
      engine.resolveEscalation(grantFor(approval!, approver.id, privateKey, 'approve')),
      engine.resolveEscalation(grantFor(approval!, approver.id, privateKey, 'reject')),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    // One escalation, one follow-up decision — never both outcomes on the chain.
    expect(engine.decisions()).toHaveLength(2);
  });
});
