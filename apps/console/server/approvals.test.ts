/**
 * The A2 loop, end to end through the CONSOLE's surface (B3).
 *
 * `world.test.ts` pins the parked state; this pins what happens when a human
 * actually answers. The signature is produced here exactly the way an
 * operator's would be on their own machine — `signApproval` over the challenge
 * the panel displayed — and submitted through `world.submitGrant`, which is
 * what `POST /api/escalations/:id/grant` calls.
 *
 * A world of its own, because the approver key is read from the environment at
 * construction and the shared world in `world.test.ts` is deliberately booted
 * with nobody able to approve — that is the public console's posture, and the
 * two cases are different postures rather than different fixtures.
 */
import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { signApproval } from '@reinconsole/policy-engine';
import { createWorld, type World } from './world';

let world: World;
let privateKey: KeyObject;

beforeAll(async () => {
  const pair = generateKeyPairSync('ed25519');
  privateKey = pair.privateKey;
  // Escaped newlines on purpose: that is how a PEM survives an env var, and a
  // key that silently failed to parse would read as "nobody can approve" —
  // the one wrong answer this panel must never give by accident.
  process.env['REIN_APPROVER_PUBLIC_KEY'] = pair.publicKey
    .export({ type: 'spki', format: 'pem' })
    .toString()
    .replace(/\n/g, '\\n');
  process.env['REIN_APPROVER_NAME'] = 'on-call';
  world = await createWorld();
}, 60_000);

afterAll(async () => {
  delete process.env['REIN_APPROVER_PUBLIC_KEY'];
  delete process.env['REIN_APPROVER_NAME'];
  await world.close();
});

describe('resolving a parked payment through the console', () => {
  it('registers the operator key from the environment, public half only', () => {
    const e = world.getState().escalations;
    expect(e.approvers).toEqual([{ id: expect.stringMatching(/^apk_/), name: 'on-call' }]);
    expect(e.pending).toHaveLength(1);
  });

  it('releases the payment against a signature made off this machine', async () => {
    const before = world.getState();
    const parked = before.escalations.pending[0]!;
    const approver = before.escalations.approvers[0]!;

    // Sign exactly the bytes the panel displayed. The verdict is INSIDE them,
    // so a captured approval can never be resubmitted as a rejection.
    expect(parked.challenge!.approve).toContain(parked.decisionId);
    expect(parked.challenge!.approve).toContain(parked.intentHash);
    const signature = signApproval(privateKey, {
      decisionId: parked.decisionId,
      intentHash: parked.intentHash,
      verdict: 'approve',
    });

    // The release moves the breaker's counting floor to NOW, and the payments
    // it is meant to put behind it were made by the boot scenario moments ago.
    // That floor is a TIMESTAMP compared inclusively (`at >= cutoff`), so on a
    // fast enough machine the scenario and this answer collapse into a single
    // millisecond: the primed payments sit AT the floor, get counted again,
    // and the breaker never appears to reset. That is the S50 macOS failure
    // one layer up, and the console has the same exposure the engine had.
    //
    // A human signing takes time, so say the ordering out loud rather than
    // borrow it from machine speed. Only Date is faked -- timers and promises
    // stay real, so the await below behaves normally -- and the clock is set
    // one millisecond past the real instant the scenario finished on, never
    // to a fixed date, which would run the engine's windows backwards.
    const answeredAt = Date.now() + 1;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(answeredAt);
    const result = await world
      .submitGrant({
        decisionId: parked.decisionId,
        intentHash: parked.intentHash,
        verdict: 'approve',
        approverKeyId: approver.id,
        signature,
      })
      .finally(() => vi.useRealTimers());
    expect(result.status).toBe('approved');

    const after = world.getState();
    // The escalating decision is never rewritten: the release is a SECOND
    // decision for the same intent, so the chain GREW rather than changed.
    expect(after.stats.decisions).toBe(before.stats.decisions + 1);
    expect(after.stats.escalate).toBe(before.stats.escalate);
    expect(after.stats.allow).toBe(before.stats.allow + 1);
    expect(result.finalDecisionId).not.toBe(parked.decisionId);

    // The panel moves it from pending to resolved, and stops offering bytes
    // that can no longer be submitted.
    expect(after.escalations.pending).toHaveLength(0);
    const resolved = after.escalations.recent[0]!;
    expect(resolved.decisionId).toBe(parked.decisionId);
    expect(resolved.status).toBe('approved');
    expect(resolved.approverName).toBe('on-call');
    expect(resolved.finalDecisionId).toBe(result.finalDecisionId);
    expect(resolved.challenge).toBeUndefined();

    // The human who waved one payment through is not asked again immediately:
    // the approval moved the breaker's counting floor to now, and the released
    // payment is counted from there — at approval time, because that is when
    // the money moves.
    const breaker = after.breakers.find((b) => b.agentName === 'probation-agent-1')!;
    expect(breaker.tripped).toBe(false);
    expect(breaker.resetAt).toBeDefined();
    expect(breaker.txCount).toBe(1);

    // And the released allowance joins the reconciliation ledger: the engine
    // charged a budget for it, so something has to answer for it.
    expect(after.reconciliation.allowed).toBe(before.reconciliation.allowed + 1);
  });

  it('refuses a second grant for the same payment', async () => {
    const resolved = world.getState().escalations.recent[0]!;
    const approver = world.getState().escalations.approvers[0]!;
    await expect(
      world.submitGrant({
        decisionId: resolved.decisionId,
        intentHash: resolved.intentHash,
        verdict: 'approve',
        approverKeyId: approver.id,
        signature: signApproval(privateKey, {
          decisionId: resolved.decisionId,
          intentHash: resolved.intentHash,
          verdict: 'approve',
        }),
      }),
    ).rejects.toThrow(/already/i);
  });

  it('refuses a verdict nobody registered signed, and changes nothing', async () => {
    const stranger = generateKeyPairSync('ed25519');
    const before = world.getState();
    const approver = before.escalations.approvers[0]!;
    const resolved = before.escalations.recent[0]!;
    await expect(
      world.submitGrant({
        decisionId: resolved.decisionId,
        intentHash: resolved.intentHash,
        verdict: 'reject',
        // Claiming the registered key id while holding a different private
        // key is the attack the signature exists to stop.
        approverKeyId: approver.id,
        signature: signApproval(stranger.privateKey, {
          decisionId: resolved.decisionId,
          intentHash: resolved.intentHash,
          verdict: 'reject',
        }),
      }),
    ).rejects.toThrow();
    expect(world.getState().stats.decisions).toBe(before.stats.decisions);
  });
});
