import { describe, expect, it } from 'vitest';
import type { ApprovalRequest } from '@reinconsole/core';
import { LoggingChannel, OrgScopedChannel, TelegramChannel } from './channels.js';
import type { LivenessAlert } from './liveness.js';
import { channelsFromEnv } from './server.js';

describe('channelsFromEnv', () => {
  it('always logs, and adds telegram only when the token and the chat id are both set', () => {
    expect(channelsFromEnv({}).map((c) => c.name)).toEqual(['log']);
    const both = channelsFromEnv({ REIN_TELEGRAM_BOT_TOKEN: ' t ', REIN_TELEGRAM_CHAT_ID: ' 42 ' });
    expect(both.map((c) => c.name)).toEqual(['log', 'telegram']);
    expect(both[0]).toBeInstanceOf(LoggingChannel);
    expect(both[1]).toBeInstanceOf(TelegramChannel);
  });

  it('refuses half a Telegram configuration rather than silently paging nobody', () => {
    expect(() => channelsFromEnv({ REIN_TELEGRAM_BOT_TOKEN: 't' })).toThrow(
      /REIN_TELEGRAM_CHAT_ID is missing/,
    );
    expect(() => channelsFromEnv({ REIN_TELEGRAM_CHAT_ID: '42' })).toThrow(
      /REIN_TELEGRAM_BOT_TOKEN is missing/,
    );
    // Whitespace is not a value.
    expect(() => channelsFromEnv({ REIN_TELEGRAM_BOT_TOKEN: 't', REIN_TELEGRAM_CHAT_ID: '  ' })).toThrow();
  });
});

describe('OrgScopedChannel (REIN_NOTIFY_ORGS)', () => {
  const OURS = 'org_01OURS0000000000000000000';
  const THEIRS = 'org_01THEIRS00000000000000000';
  const agents: Record<string, string> = { agt_ours: OURS, agt_theirs: THEIRS };
  const orgOfAgent = (id: string) => agents[id];
  const challenges = { approve: 'APPROVE-BYTES', reject: 'REJECT-BYTES' };
  const request = (over: Partial<ApprovalRequest>): ApprovalRequest => ({
    decisionId: 'dec_1',
    intentId: 'int_1',
    intentHash: 'h',
    agentId: 'agt_theirs',
    orgId: THEIRS,
    vendorHost: 'secret-vendor.example',
    resource: '/private/thing',
    amount: '12.50',
    asset: 'USDC',
    chain: 'base',
    reason: 'over the per-call cap',
    breakers: [],
    status: 'pending',
    createdAt: new Date(0),
    expiresAt: new Date(60_000),
    ...over,
  });
  const alert = (agentId: string): LivenessAlert => ({
    agentId,
    expectation: { interval: '15m', intervalMs: 900_000, graceMs: 0, note: 'tenant poller' },
    silentMs: 3_600_000,
    at: 0,
  } as LivenessAlert);
  const logged = () => {
    const lines: string[] = [];
    return { lines, channel: new LoggingChannel({ write: (m) => lines.push(m) }) };
  };

  it("delivers the operator's own orgs in full, and another org's only as ids", () => {
    const { lines, channel } = logged();
    const scoped = new OrgScopedChannel(channel, { orgs: [OURS], orgOfAgent, withheld: (w) => `${w} (withheld)` });
    scoped.deliver(request({ agentId: 'agt_ours', orgId: OURS }), challenges);
    expect(lines[0]).toContain('secret-vendor.example');
    scoped.deliver(request({}), challenges);
    expect(lines[1]).toBe(`[rein] escalation dec_1 parked for org ${THEIRS} (withheld)`);
    for (const leak of ['secret-vendor.example', '/private/thing', '12.50', 'over the per-call cap', 'APPROVE-BYTES']) {
      expect(lines[1]).not.toContain(leak);
    }
  });

  it('sends nothing at all for another org when no withheld line is given (Telegram)', () => {
    const { lines, channel } = logged();
    const scoped = new OrgScopedChannel(channel, { orgs: [OURS], orgOfAgent });
    scoped.deliver(request({}), challenges);
    scoped.alert(alert('agt_theirs'));
    expect(lines).toEqual([]);
  });

  it("finds an alarm's org through the agent, since an alarm names only the agent", () => {
    const { lines, channel } = logged();
    const scoped = new OrgScopedChannel(channel, { orgs: [OURS], orgOfAgent });
    scoped.alert(alert('agt_ours'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('tenant poller');
  });

  it('delivers unattributed news -- only an unscoped operator can have produced it (S56)', () => {
    const { lines, channel } = logged();
    const scoped = new OrgScopedChannel(channel, { orgs: [OURS], orgOfAgent });
    const { orgId: _none, ...unattributed } = request({ agentId: 'agt_unregistered' });
    scoped.deliver(unattributed as ApprovalRequest, challenges);
    scoped.alert(alert('agt_unregistered'));
    expect(lines).toHaveLength(2);
  });

  it('channelsFromEnv narrows both channels only when REIN_NOTIFY_ORGS is set', () => {
    const env = { REIN_TELEGRAM_BOT_TOKEN: 't', REIN_TELEGRAM_CHAT_ID: '42' };
    expect(channelsFromEnv(env).every((c) => !(c instanceof OrgScopedChannel))).toBe(true);
    const scoped = channelsFromEnv({ ...env, REIN_NOTIFY_ORGS: ` ${OURS} , ` }, { orgOfAgent });
    expect(scoped.map((c) => c.name)).toEqual(['log', 'telegram']);
    expect(scoped.every((c) => c instanceof OrgScopedChannel)).toBe(true);
  });
});

describe('TelegramChannel', () => {
  const token = '7439012345:AAF-e2e-test-token-not-real';
  const url = (input: unknown) => (input instanceof Request ? input.url : String(input));

  it('posts to the Bot API with the token in the path and the chat id in the body', async () => {
    const calls: { url: string; body: unknown }[] = [];
    const channel = new TelegramChannel({
      botToken: token,
      chatId: 42,
      fetch: async (input, init) => {
        calls.push({ url: url(input), body: JSON.parse(String(init?.body)) });
        return new Response('{"ok":true}', { status: 200 });
      },
    });
    await channel.send('hello');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`https://api.telegram.org/bot${token}/sendMessage`);
    expect(calls[0]!.body).toMatchObject({ chat_id: '42', text: 'hello' });
  });

  it('never lets the token out through a transport failure', async () => {
    // The request URL IS the token, and undici quotes the URL in the errors
    // it throws. A channel that rethrew the transport error as-is would hand
    // the bot token to every log line and error hook downstream of it.
    const channel = new TelegramChannel({
      botToken: token,
      chatId: 42,
      fetch: async (input) => {
        throw new TypeError(`fetch failed for ${url(input)}`, {
          cause: Object.assign(new Error(`connect ECONNREFUSED ${url(input)}`), {
            code: 'ECONNREFUSED',
          }),
        });
      },
    });
    const failure = await channel.send('hello').then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(failure).toBeInstanceOf(Error);
    const { message, cause } = failure as Error;
    expect(message).not.toContain(token);
    expect(message).toContain('[redacted]');
    // The diagnosis survives the redaction: what failed, and with which code.
    expect(message).toMatch(/telegram sendMessage failed/);
    expect(message).toContain('ECONNREFUSED');
    // No cause chain rides along -- that is where the original URL lives.
    expect(cause).toBeUndefined();
    // And the channel object itself carries no token a dump could print.
    expect(JSON.stringify(channel)).not.toContain(token);
  });

  it('reports a refused send by status, never by URL', async () => {
    const channel = new TelegramChannel({
      botToken: token,
      chatId: 42,
      fetch: async () => new Response('forbidden', { status: 403 }),
    });
    await expect(channel.send('hello')).rejects.toThrow(/failed: 403$/);
  });
});
