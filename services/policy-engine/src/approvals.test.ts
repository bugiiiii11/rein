import { generateKeyPairSync } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { canonicalApproval, newId, type ApprovalChallenges, type ApprovalRequest, type Decision, type PaymentIntent } from '@reinconsole/core';
import {
  ApprovalError,
  ApprovalService,
  signApproval,
  verifyApproval,
  type ApprovalChannel,
} from './approvals.js';
import { formatChallenge, LoggingApprovalChannel, TelegramApprovalChannel } from './channels.js';

function approverKeyPair() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { privateKey, publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString() };
}

function intentFixture(): PaymentIntent {
  return {
    id: newId('int'),
    agentId: newId('agt'),
    vendor: { host: 'api.vendor.com', address: '0xVendor' },
    resource: '/v1/report',
    amount: '25.00',
    asset: 'USDC',
    chain: 'base',
    taskContext: {},
    nonce: newId('non'),
    createdAt: new Date(),
  };
}

function decisionFixture(intent: PaymentIntent): Decision {
  return {
    id: newId('dec'),
    intentId: intent.id,
    intentHash: 'a'.repeat(64),
    outcome: 'escalate',
    matchedRules: ['big-ticket'],
    reason: 'escalated by: big-ticket',
    policyId: 'pol_main',
    policyVersion: '1',
    prevHash: 'genesis',
    hash: 'b'.repeat(64),
    signature: 'sig',
    latencyMs: 1,
    decidedAt: new Date(),
  };
}

class RecordingChannel implements ApprovalChannel {
  readonly name = 'recording';
  readonly delivered: Array<{ request: ApprovalRequest; challenges: ApprovalChallenges }> = [];
  deliver(request: ApprovalRequest, challenges: ApprovalChallenges): void {
    this.delivered.push({ request, challenges });
  }
}

async function parked(options: { ttlMs?: number; now?: () => number; channels?: ApprovalChannel[] } = {}) {
  const service = new ApprovalService(options);
  const { privateKey, publicKeyPem } = approverKeyPair();
  const approver = await service.registerApprover({
    orgId: newId('org'),
    name: 'Finance',
    publicKey: publicKeyPem,
  });
  const intent = intentFixture();
  const decision = decisionFixture(intent);
  const request = await service.open(intent, decision);
  return { service, approver, privateKey, intent, decision, request };
}

describe('ApprovalService', () => {
  it('parks an escalation with the payment facts a human needs to judge it', async () => {
    const channel = new RecordingChannel();
    const { request, intent } = await parked({ channels: [channel] });

    expect(request.status).toBe('pending');
    expect(request.amount).toBe('25.00');
    expect(request.vendorHost).toBe('api.vendor.com');
    expect(request.reason).toBe('escalated by: big-ticket');
    expect(request.expiresAt.getTime()).toBeGreaterThan(request.createdAt.getTime());
    expect(request.intentId).toBe(intent.id);

    // Delivery carries both byte-strings; the channel is told, never asked.
    expect(channel.delivered).toHaveLength(1);
    expect(channel.delivered[0]?.challenges.approve).toContain('"verdict":"approve"');
    expect(channel.delivered[0]?.challenges.reject).toContain('"verdict":"reject"');
  });

  it('verifies a signature made over the exact challenge', async () => {
    const { service, approver, privateKey, request } = await parked();
    const signature = signApproval(privateKey, {
      decisionId: request.decisionId,
      intentHash: request.intentHash,
      verdict: 'approve',
    });

    const verified = service.verify({
      decisionId: request.decisionId,
      intentHash: request.intentHash,
      verdict: 'approve',
      approverKeyId: approver.id,
      signature,
    });
    expect(verified.verdict).toBe('approve');
    expect(verified.approver.id).toBe(approver.id);
  });

  it('will not let an approval signature be replayed as a rejection', async () => {
    const { service, approver, privateKey, request } = await parked();
    // The verdict is inside the signed bytes, so the same signature submitted
    // under the other verdict verifies against different content and fails.
    const approveSig = signApproval(privateKey, {
      decisionId: request.decisionId,
      intentHash: request.intentHash,
      verdict: 'approve',
    });

    expect(() =>
      service.verify({
        decisionId: request.decisionId,
        intentHash: request.intentHash,
        verdict: 'reject',
        approverKeyId: approver.id,
        signature: approveSig,
      }),
    ).toThrow(/signature does not verify/);
  });

  it('rejects a signature from an unregistered or revoked key', async () => {
    const { service, request, approver } = await parked();
    const stranger = approverKeyPair();
    const forged = signApproval(stranger.privateKey, {
      decisionId: request.decisionId,
      intentHash: request.intentHash,
      verdict: 'approve',
    });

    // Right bytes, wrong key: the engine has never seen this key id.
    expect(() =>
      service.verify({
        decisionId: request.decisionId,
        intentHash: request.intentHash,
        verdict: 'approve',
        approverKeyId: newId('apk'),
        signature: forged,
      }),
    ).toThrow(/no such approver key/);

    // Registered key id, but a signature the key did not make.
    expect(() =>
      service.verify({
        decisionId: request.decisionId,
        intentHash: request.intentHash,
        verdict: 'approve',
        approverKeyId: approver.id,
        signature: forged,
      }),
    ).toThrow(/does not verify/);
  });

  it('refuses a revoked approver', async () => {
    const { service, approver, privateKey, request } = await parked();
    await service.revokeApprover(approver.id);
    const signature = signApproval(privateKey, {
      decisionId: request.decisionId,
      intentHash: request.intentHash,
      verdict: 'approve',
    });

    let error: ApprovalError | undefined;
    try {
      service.verify({
        decisionId: request.decisionId,
        intentHash: request.intentHash,
        verdict: 'approve',
        approverKeyId: approver.id,
        signature,
      });
    } catch (err) {
      error = err as ApprovalError;
    }
    expect(error?.code).toBe('approver_revoked');
    expect(service.hasActiveApprover()).toBe(false);
  });

  it('refuses a grant whose intentHash is not the one it parked', async () => {
    const { service, approver, privateKey, request } = await parked();
    const otherHash = 'f'.repeat(64);
    const signature = signApproval(privateKey, {
      decisionId: request.decisionId,
      intentHash: otherHash,
      verdict: 'approve',
    });

    expect(() =>
      service.verify({
        decisionId: request.decisionId,
        intentHash: otherHash,
        verdict: 'approve',
        approverKeyId: approver.id,
        signature,
      }),
    ).toThrow(/does not match the request/);
  });

  it('stops answering once the TTL lapses, and reports the lapse', async () => {
    let now = 1_700_000_000_000;
    const { service, approver, privateKey, request } = await parked({
      ttlMs: 60_000,
      now: () => now,
    });
    const signature = signApproval(privateKey, {
      decisionId: request.decisionId,
      intentHash: request.intentHash,
      verdict: 'approve',
    });

    expect(service.pending()).toHaveLength(1);
    now += 60_001;
    expect(service.pending()).toHaveLength(0);
    expect(service.lapsed()).toHaveLength(1);
    expect(() =>
      service.verify({
        decisionId: request.decisionId,
        intentHash: request.intentHash,
        verdict: 'approve',
        approverKeyId: approver.id,
        signature,
      }),
    ).toThrow(/expired/);
  });

  it('refuses a second verdict once one has been settled', async () => {
    const { service, approver, privateKey, request } = await parked();
    await service.settle(request.decisionId, {
      status: 'approved',
      finalDecisionId: newId('dec'),
      approverKeyId: approver.id,
    });
    const signature = signApproval(privateKey, {
      decisionId: request.decisionId,
      intentHash: request.intentHash,
      verdict: 'reject',
    });

    expect(() =>
      service.verify({
        decisionId: request.decisionId,
        intentHash: request.intentHash,
        verdict: 'reject',
        approverKeyId: approver.id,
        signature,
      }),
    ).toThrow(/already approved/);
  });

  it('keeps the request parked when a channel throws', async () => {
    const failures: string[] = [];
    const broken: ApprovalChannel = {
      name: 'broken',
      deliver() {
        throw new Error('telegram is down');
      },
    };
    const service = new ApprovalService({
      channels: [broken],
      onDeliveryError: (channel) => failures.push(channel),
    });
    const intent = intentFixture();
    const request = await service.open(intent, decisionFixture(intent));

    // A dead channel must never decide a payment: it stays pending and will
    // expire into a deny if nobody answers.
    expect(request.status).toBe('pending');
    expect(failures).toEqual(['broken']);
  });

  it('rejects approver key material that is not an ed25519 public key', async () => {
    const service = new ApprovalService();
    await expect(
      service.registerApprover({ orgId: newId('org'), name: 'bad', publicKey: 'not-a-pem' }),
    ).rejects.toThrow(/not a readable PEM key/);

    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
    await expect(
      service.registerApprover({
        orgId: newId('org'),
        name: 'rsa',
        publicKey: rsa.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      }),
    ).rejects.toThrow(/must be ed25519/);
  });
});

describe('approval canonicalization', () => {
  it('is domain-separated from the decision signature space', () => {
    expect(canonicalApproval({ decisionId: 'dec_1', intentHash: 'h', verdict: 'approve' })).toContain(
      '"rein":"approval/v1"',
    );
  });

  it('verifies only the exact content that was signed', () => {
    const { privateKey, publicKeyPem } = approverKeyPair();
    const content = { decisionId: 'dec_1', intentHash: 'h', verdict: 'approve' as const };
    const signature = signApproval(privateKey, content);

    expect(verifyApproval(publicKeyPem, content, signature)).toBe(true);
    expect(verifyApproval(publicKeyPem, { ...content, decisionId: 'dec_2' }, signature)).toBe(false);
    expect(verifyApproval(publicKeyPem, { ...content, intentHash: 'other' }, signature)).toBe(false);
    expect(verifyApproval(publicKeyPem, content, 'bm90LWEtc2ln')).toBe(false);
    expect(verifyApproval('not-a-key', content, signature)).toBe(false);
  });
});

describe('approval channels', () => {
  it('prints the payment facts and both challenges, and nothing to click', async () => {
    const lines: string[] = [];
    const channel = new LoggingApprovalChannel({ write: (m) => lines.push(m) });
    const { request } = await parked({ channels: [channel] });
    const text = formatChallenge(request, {
      approve: 'APPROVE-BYTES',
      reject: 'REJECT-BYTES',
    });

    expect(text).toContain('25.00 USDC on base -> api.vendor.com');
    expect(text).toContain('APPROVE-BYTES');
    expect(text).toContain('REJECT-BYTES');
    expect(text).toContain('Replying here approves nothing.');
    expect(lines).toHaveLength(1);
  });

  it('sends telegram a plain-text notification with no reply markup', async () => {
    const sent: Array<Record<string, unknown>> = [];
    const channel = new TelegramApprovalChannel({
      botToken: 'test-token',
      chatId: 42,
      fetch: async (_url, init) => {
        sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response('{"ok":true}', { status: 200 });
      },
    });
    const { request } = await parked({ channels: [channel] });
    expect(request.status).toBe('pending');

    const body = sent[0];
    expect(body?.['chat_id']).toBe('42');
    expect(String(body?.['text'])).toContain('needs your approval');
    // No buttons, and no parse mode: an attacker-influenced vendor host must
    // not be able to inject markup into what a human reads before approving.
    expect(body).not.toHaveProperty('reply_markup');
    expect(body).not.toHaveProperty('parse_mode');
  });
});
