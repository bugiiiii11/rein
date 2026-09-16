import { describe, expect, it } from 'vitest';
import { newId } from '@reinconsole/core';
import { ApprovalService, PolicyEngine, buildServer } from '@reinconsole/policy-engine';
import type { AddressInfo } from 'node:net';
import { createToolContext } from './index.js';
import { reinTools, type ReinTool, type ToolResult } from './tools.js';
import { configFromEnv, networksFor, ConfigError } from './config.js';

/** Boot a real engine over loopback, so the tools talk to the real HTTP API. */
/** `registerAgent` parses a whole Agent document, so tests supply one. */
async function register(engine: PolicyEngine, name: string, labels: string[] = []) {
  return engine.registerAgent({
    id: newId('agt'),
    orgId: newId('org'),
    name,
    labels,
    status: 'active',
    createdAt: new Date(),
  });
}

async function startEngine(
  engine: PolicyEngine,
): Promise<{ url: string; stop: () => Promise<void> }> {
  // No `auth` option: an embedded engine on an ephemeral port, like the demos.
  const app = buildServer(engine);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const { port } = app.server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, stop: () => app.close() };
}

function toolNamed(tools: ReinTool[], name: string): ReinTool {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`no tool ${name}`);
  return tool;
}

function payload(result: ToolResult): Record<string, unknown> {
  const text = result.content[0]?.text ?? '';
  return JSON.parse(text) as Record<string, unknown>;
}

describe('the tool surface', () => {
  const tools = reinTools(
    createToolContext({ engineUrl: 'http://127.0.0.1:1', agentId: newId('agt') }),
  );

  /**
   * The load-bearing test of C1. The client on the other end of an MCP pipe is
   * the AGENT -- the thing being governed -- so the surface is asserted WHOLE,
   * not sampled: adding a tool that widens the agent's own authority has to
   * break this first. It is the MCP twin of the console panel's
   * "renders no button, input or link" (B3).
   */
  it('is exactly five tools, and none of them widens the agent own authority', () => {
    expect(tools.map((t) => t.name)).toEqual([
      'rein_fetch',
      'rein_status',
      'rein_receipts',
      'rein_escalations',
      'rein_heartbeat',
    ]);
  });

  it('offers no way to approve, reject or extend an escalation', () => {
    // An approval is an ed25519 signature over decisionId+intentHash (A2). A
    // tool call is not a signature, and one that stood in for one would put the
    // authority to move money behind whoever holds the pipe.
    const surface = JSON.stringify(
      tools.map((t) => ({ name: t.name, schema: Object.keys(t.inputSchema) })),
    );
    for (const forbidden of ['approve', 'reject', 'grant', 'resolve', 'sign']) {
      expect(surface.toLowerCase()).not.toContain(forbidden);
    }
  });

  it('offers no way to change policy, agent state or credentials', () => {
    const names = tools.map((t) => t.name);
    for (const forbidden of ['policy', 'policies', 'freeze', 'unfreeze', 'key', 'approver']) {
      expect(names.some((n) => n.includes(forbidden))).toBe(false);
    }
  });

  it('marks every tool but the paying one read-only, so the harness can see the boundary', () => {
    const writers = tools.filter((t) => t.annotations.readOnlyHint !== true).map((t) => t.name);
    // rein_heartbeat writes a sighting but widens nothing: an agent able to make
    // the call is, by construction, exactly as alive as it claims.
    expect(writers).toEqual(['rein_fetch', 'rein_heartbeat']);
  });

  it('never takes an agent id from the caller', () => {
    // One server speaks for ONE agent. An agent id the caller could choose
    // would turn an agent-scoped surface into a cross-agent admin API.
    for (const tool of tools) {
      expect(Object.keys(tool.inputSchema)).not.toContain('agentId');
    }
  });
});

describe('rein_fetch', () => {
  it('reports a denial as a tool error carrying the reason, not as a result', async () => {
    const engine = new PolicyEngine();
    const agent = await register(engine, 'blocked');
    engine.addPolicy({
      policyId: 'pol_deny',
      appliesTo: { agents: [agent.id] },
      rules: [{ id: 'no-spend', deny: { amountGt: '0.00' } }],
      default: 'deny',
    });
    const engineServer = await startEngine(engine);

    const vendor = paywall('0.05');
    const tools = reinTools(
      createToolContext({
        engineUrl: engineServer.url,
        agentId: agent.id,
        fetch: vendor,
      }),
    );

    const result = await toolNamed(tools, 'rein_fetch').handler({
      url: 'https://vendor.test/v1/report',
    });

    expect(result.isError).toBe(true);
    const body = payload(result);
    expect(body['rein']).toBe('DENIED');
    expect(body['amount']).toBe('0.05 USDC');
    expect(String(body['guidance'])).toContain('refused');
    // The vendor was asked once (the unpaid probe) and never paid.
    expect(vendor.calls).toBe(1);

    await engineServer.stop();
  });

  it('says ALLOWED_BUT_UNPAID when policy allows and no payer is configured', async () => {
    const engine = new PolicyEngine();
    const agent = await register(engine, 'advisory');
    engine.addPolicy({
      policyId: 'pol_allow',
      appliesTo: { agents: [agent.id] },
      rules: [{ id: 'small', allow: { amountGt: '0.00' } }],
      default: 'deny',
    });
    const engineServer = await startEngine(engine);

    const vendor = paywall('0.01');
    const tools = reinTools(
      createToolContext({ engineUrl: engineServer.url, agentId: agent.id, fetch: vendor }),
    );

    const body = payload(
      await toolNamed(tools, 'rein_fetch').handler({ url: 'https://vendor.test/v1/report' }),
    );

    // The honest branch: a 402 that reads as a denial would be the opposite of
    // what happened -- policy said yes, this install simply cannot pay.
    expect(body['status']).toBe(402);
    expect(body['rein']).toBe('ALLOWED_BUT_UNPAID');
    expect((body['rein_receipt'] as Record<string, unknown>)['outcome']).toBe('allow');

    await engineServer.stop();
  });

  it('truncates a body that would flood the context, and says so', async () => {
    const engine = new PolicyEngine();
    const agent = await register(engine, 'chatty');
    const engineServer = await startEngine(engine);

    const big = 'x'.repeat(5000);
    const tools = reinTools(
      createToolContext({
        engineUrl: engineServer.url,
        agentId: agent.id,
        maxBodyBytes: 100,
        fetch: async () => new Response(big, { status: 200 }),
      }),
    );

    const body = payload(
      await toolNamed(tools, 'rein_fetch').handler({ url: 'https://vendor.test/free' }),
    );
    expect(String(body['body']).length).toBe(100);
    expect(String(body['bodyTruncated'])).toContain('100 bytes');
    // No paywall, so no payment was involved -- and the result says so rather
    // than implying a receipt that does not exist.
    expect(body['rein']).toContain('no payment');

    await engineServer.stop();
  });
});

describe('rein_status', () => {
  it('reports only the policies this agent is actually subject to', async () => {
    const engine = new PolicyEngine();
    const mine = await register(engine, 'mine', ['research']);
    const other = await register(engine, 'other', ['ops']);
    engine.addPolicy({ policyId: 'pol_by_agent', appliesTo: { agents: [mine.id] }, rules: [] });
    engine.addPolicy({ policyId: 'pol_by_label', appliesTo: { labels: ['research'] }, rules: [] });
    engine.addPolicy({ policyId: 'pol_other', appliesTo: { agents: [other.id] }, rules: [] });
    engine.addPolicy({ policyId: 'pol_everyone', rules: [] });
    const engineServer = await startEngine(engine);

    const tools = reinTools(createToolContext({ engineUrl: engineServer.url, agentId: mine.id }));
    const body = payload(await toolNamed(tools, 'rein_status').handler({}));
    const ids = (body['policies'] as { policyId: string }[]).map((p) => p.policyId);

    expect(ids).toContain('pol_by_agent');
    expect(ids).toContain('pol_by_label');
    expect(ids).toContain('pol_everyone');
    // Reported to the agent as "the rules over you", so another agent's policy
    // is misinformation, not merely noise.
    expect(ids).not.toContain('pol_other');

    expect(body['mode']).toContain('advisory');
    expect(body['liveness']).toContain('not watched');

    await engineServer.stop();
  });

  it('degrades per-read rather than failing whole when the engine is unreachable', async () => {
    const tools = reinTools(
      createToolContext({ engineUrl: 'http://127.0.0.1:1', agentId: newId('agt') }),
    );
    const body = payload(await toolNamed(tools, 'rein_status').handler({}));
    expect(String(body['engine'])).toContain('unavailable');
    expect(String(body['policies'])).toContain('unavailable');
  });
});

describe('rein_escalations', () => {
  it('says an engine with no approval tier can never park a payment', async () => {
    const engine = new PolicyEngine();
    const agent = await register(engine, 'unparked');
    const engineServer = await startEngine(engine);

    const tools = reinTools(createToolContext({ engineUrl: engineServer.url, agentId: agent.id }));
    const body = payload(await toolNamed(tools, 'rein_escalations').handler({}));

    // Not an outage: a deployment with no approval service can only allow or
    // deny, so an agent told "unavailable" would poll an empty queue forever.
    expect(String(body['escalations'])).toContain('NOT SUPPORTED');

    await engineServer.stop();
  });

  it('reports a parked payment, and says when nobody can sign for it', async () => {
    const engine = new PolicyEngine({ approvals: new ApprovalService({ ttlMs: 60_000 }) });
    const agent = await register(engine, 'parked');
    await engine.addPolicy({
      policyId: 'pol_review',
      appliesTo: { agents: [agent.id] },
      rules: [{ id: 'big-ticket', escalate: { amountGt: '0.00' } }],
      default: 'deny',
    });
    const engineServer = await startEngine(engine);

    const tools = reinTools(
      createToolContext({
        engineUrl: engineServer.url,
        agentId: agent.id,
        fetch: paywall('0.10'),
      }),
    );

    const blockedResult = await toolNamed(tools, 'rein_fetch').handler({
      url: 'https://vendor.test/v1/report',
    });
    expect(blockedResult.isError).toBe(true);
    const blockedBody = payload(blockedResult);
    expect(blockedBody['rein']).toBe('ESCALATED');
    // Parked, not refused -- and the guidance says the agent cannot resolve it.
    expect(String(blockedBody['guidance'])).toContain('Nothing you can send will approve it');

    const body = payload(await toolNamed(tools, 'rein_escalations').handler({}));
    const pending = body['pending'] as Record<string, unknown>[];
    expect(pending).toHaveLength(1);
    expect(pending[0]?.['amount']).toBe('0.1 USDC');

    // The B3 honesty valve: a parked payment with no registered approver is
    // awaiting an expiry, not a human.
    expect(String(body['approvers'])).toContain('NONE registered');

    await engineServer.stop();
  });
});

describe('configFromEnv', () => {
  const agentId = newId('agt');

  it('turns every misconfiguration into a ConfigError, not a schema stack', async () => {
    // A stdio server that dies at boot shows a harness nothing but its stderr,
    // so "you typed the agent id wrong" has to survive as a readable line.
    await expect(configFromEnv({})).rejects.toBeInstanceOf(ConfigError);
    await expect(configFromEnv({ REIN_ENGINE_URL: 'http://x' })).rejects.toBeInstanceOf(
      ConfigError,
    );
    await expect(
      configFromEnv({ REIN_ENGINE_URL: 'not a url', REIN_AGENT_ID: agentId }),
    ).rejects.toThrow(/not a URL/);
    await expect(
      configFromEnv({ REIN_ENGINE_URL: 'http://x', REIN_AGENT_ID: 'my-agent' }),
    ).rejects.toThrow(/agt_/);
    await expect(
      configFromEnv({
        REIN_ENGINE_URL: 'http://x',
        REIN_AGENT_ID: agentId,
        REIN_PAYER_PRIVATE_KEY: 'not-a-key',
      }),
    ).rejects.toThrow(/32-byte hex/);
  });

  it('defaults to advisory mode, and to not holding a tool call open', async () => {
    const config = await configFromEnv({ REIN_ENGINE_URL: 'http://x', REIN_AGENT_ID: agentId });
    // A key has to be handed over deliberately, not acquired by installing an
    // MCP server.
    expect(config.payer).toBeUndefined();
    // An escalation TTL runs for hours; a harness's tool timeout for seconds.
    expect(config.escalationWaitMs).toBe(0);
    // Testnet unless someone says otherwise: the default must be the one that
    // cannot spend real money.
    expect(config.networkProfile).toBe('testnet');
  });

  describe('REIN_NETWORK_PROFILE', () => {
    const base = { REIN_ENGINE_URL: 'http://x', REIN_AGENT_ID: agentId };

    it('accepts either profile, case-insensitively', async () => {
      expect((await configFromEnv({ ...base, REIN_NETWORK_PROFILE: 'mainnet' })).networkProfile).toBe(
        'mainnet',
      );
      expect((await configFromEnv({ ...base, REIN_NETWORK_PROFILE: ' TESTNET ' })).networkProfile).toBe(
        'testnet',
      );
      expect((await configFromEnv({ ...base, REIN_NETWORK_PROFILE: '' })).networkProfile).toBe(
        'testnet',
      );
    });

    /**
     * A typo must not fall back to testnet. An operator who wrote `mainet`
     * meant mainnet, and a vendor quietly taking real requests while being
     * paid in play money looks exactly like everything working.
     */
    it('refuses an unknown profile instead of defaulting', async () => {
      await expect(
        configFromEnv({ ...base, REIN_NETWORK_PROFILE: 'mainet' }),
      ).rejects.toBeInstanceOf(ConfigError);
      await expect(configFromEnv({ ...base, REIN_NETWORK_PROFILE: 'mainet' })).rejects.toThrow(
        /"testnet" or "mainnet"/,
      );
    });

    /**
     * config.ts keeps its OWN copy of each profile's network ids, because
     * importing @reinconsole/x402-rails there would pull viem into every
     * advisory cold start. This is the pin that stops the copy drifting --
     * a test may import the real profiles freely.
     */
    // 30s, not the 5s default: this is the only test here that loads
    // @reinconsole/x402-rails, and viem behind it, so its cost is a cold
    // module graph rather than anything it asserts. It passes in ~1.7s alone
    // and times out inside a full parallel `turbo run test`.
    it('lists exactly the networks the real profiles declare', { timeout: 30_000 }, async () => {
      const { PROFILES } = await import('@reinconsole/x402-rails');
      for (const name of ['testnet', 'mainnet'] as const) {
        expect([...networksFor(name)].sort()).toEqual(
          [PROFILES[name].network, PROFILES[name].caip2].sort(),
        );
      }
    });
  });
});

/** A vendor that answers every request with an x402 v1 paywall. */
function paywall(amount: string): ((
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>) & {
  calls: number;
} {
  const impl = async (): Promise<Response> => {
    impl.calls += 1;
    return new Response(
      JSON.stringify({
        x402Version: 1,
        accepts: [
          {
            scheme: 'exact',
            network: 'base-sepolia',
            maxAmountRequired: String(Math.round(Number(amount) * 1e6)),
            asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
            payTo: '0x0000000000000000000000000000000000000001',
            resource: 'https://vendor.test/v1/report',
            description: 'test',
            mimeType: 'application/json',
            maxTimeoutSeconds: 60,
          },
        ],
      }),
      { status: 402, headers: { 'content-type': 'application/json' } },
    );
  };
  impl.calls = 0;
  return impl;
}
