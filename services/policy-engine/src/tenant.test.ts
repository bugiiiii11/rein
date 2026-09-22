import { generateKeyPairSync } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { newId } from '@reinconsole/core';
import { ApiKeyAuth } from '@reinconsole/core/auth';
import { buildServer, registeredRoutes, tenantRoute } from './server.js';
import { ApprovalService, signApproval } from './approvals.js';
import { PolicyEngine } from './engine.js';
import { ownsAgent, ownsOrg, scopeOf } from './tenant.js';

/**
 * Sprint 2: an API key can only see, spend, approve and govern inside its org.
 *
 * The fixture is two orgs that know nothing about each other, a ROOT key with
 * no org (the operator / self-hoster key, which must keep behaving exactly as
 * it always has) and four A-scoped keys, one per scope. Every test below is
 * some version of the same question: can A reach into B?
 */

const ORG_A = newId('org');
const ORG_B = newId('org');

async function tenantWorld() {
  const auth = new ApiKeyAuth();
  const approvals = new ApprovalService({ ttlMs: 60_000 });
  const engine = new PolicyEngine({ approvals });

  const root = await auth.issue({ name: 'operator', scopes: ['admin'] });
  const adminA = await auth.issue({ name: 'a-admin', scopes: ['admin'], orgId: ORG_A });
  const readA = await auth.issue({ name: 'a-read', scopes: ['read'], orgId: ORG_A });
  const evalA = await auth.issue({ name: 'a-eval', scopes: ['evaluate'], orgId: ORG_A });
  const approveA = await auth.issue({ name: 'a-approve', scopes: ['approve'], orgId: ORG_A });
  const adminB = await auth.issue({ name: 'b-admin', scopes: ['admin'], orgId: ORG_B });

  const agentA = await engine.registerAgent({
    id: newId('agt'),
    orgId: ORG_A,
    name: 'a-1',
    createdAt: new Date(),
  });
  const agentB = await engine.registerAgent({
    id: newId('agt'),
    orgId: ORG_B,
    name: 'b-1',
    createdAt: new Date(),
  });

  const app = buildServer(engine, { auth });
  const as = (issued: { secret: string }) => ({ authorization: `Bearer ${issued.secret}` });
  return { app, engine, approvals, auth, root, adminA, readA, evalA, approveA, adminB, agentA, agentB, as };
}

const intent = (agentId: string, amount = '0.01') => ({
  agentId,
  vendor: { host: 'api.vendor.com', address: '0xabc' },
  resource: '/v1/search',
  amount,
  asset: 'USDC',
  chain: 'base',
});

describe('tenant isolation: the route classifier', () => {
  it('classifies every registered route — a new one is unreachable until it is', async () => {
    const { app } = await tenantWorld();
    await app.ready();
    // Fastify's own table, not a hand-written list: a route added without a
    // tenant rule fails here rather than quietly serving every org's rows.
    const registered = registeredRoutes(app).map((r) => ({
      method: r.method,
      path: r.path.replace(/:[^/]+/g, 'x'),
    }));

    expect(registered.length).toBeGreaterThan(20);
    const unclassified = registered.filter((r) => !tenantRoute(r.method, r.path));
    expect(unclassified).toEqual([]);
    await app.close();
  });

  it('refuses a scoped key on a route with no tenant rule', async () => {
    const { app, adminA, as } = await tenantWorld();
    // Not a registered route, so it is also not classified: the 403 arrives
    // from the onRequest hook, before routing could 404 it.
    const res = await app.inject({ method: 'POST', url: '/v1/future', headers: as(adminA) });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('route_not_scopable');
    await app.close();
  });

  it('lets the unscoped operator key through the same route', async () => {
    const { app, root, as } = await tenantWorld();
    const res = await app.inject({ method: 'POST', url: '/v1/future', headers: as(root) });
    expect(res.statusCode).toBe(404); // routing, not tenancy
    await app.close();
  });
});

describe('tenant isolation: agents', () => {
  it('shows a scoped reader only its own org, and the root key both', async () => {
    const { app, readA, root, agentA, as } = await tenantWorld();
    const mine = await app.inject({ method: 'GET', url: '/v1/agents', headers: as(readA) });
    expect(mine.json().map((a: { id: string }) => a.id)).toEqual([agentA.id]);

    const all = await app.inject({ method: 'GET', url: '/v1/agents', headers: as(root) });
    expect(all.json()).toHaveLength(2);
    await app.close();
  });

  it('stamps a registration with the CALLER org, ignoring the body', async () => {
    const { app, adminA, as } = await tenantWorld();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/agents',
      headers: as(adminA),
      payload: { orgId: ORG_B, name: 'trying-to-plant-one' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().orgId).toBe(ORG_A);
    await app.close();
  });

  it('404s freeze, breakers and liveness on another org’s agent', async () => {
    const { app, adminA, readA, agentB, as } = await tenantWorld();
    const freeze = await app.inject({
      method: 'POST',
      url: `/v1/agents/${agentB.id}/freeze`,
      headers: as(adminA),
    });
    expect(freeze.statusCode).toBe(404);

    const breakers = await app.inject({
      method: 'GET',
      url: `/v1/agents/${agentB.id}/breakers`,
      headers: as(readA),
    });
    expect(breakers.statusCode).toBe(404);

    const watch = await app.inject({
      method: 'PUT',
      url: `/v1/agents/${agentB.id}/liveness`,
      headers: as(adminA),
      payload: { interval: '1h' },
    });
    expect(watch.statusCode).toBe(404);
    await app.close();
  });

  it('still lets the root key freeze an id the registry has never seen', async () => {
    const { app, root, as } = await tenantWorld();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/agents/${newId('agt')}/freeze`,
      headers: as(root),
    });
    expect(res.statusCode).toBe(204);
    await app.close();
  });
});

describe('tenant isolation: policies', () => {
  it('never lets another org’s policy govern an agent, however broad its targeting', async () => {
    const { app, engine, adminB, evalA, agentA, as } = await tenantWorld();
    // B writes the broadest policy there is: no targeting at all, deny by
    // default. Before tenancy this governed every agent in the engine.
    const written = await app.inject({
      method: 'POST',
      url: '/v1/policies',
      headers: as(adminB),
      payload: { policyId: 'pol_b_wide', rules: [], default: 'deny' },
    });
    expect(written.json().orgId).toBe(ORG_B);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/evaluate',
      headers: as(evalA),
      payload: intent(agentA.id),
    });
    expect(res.statusCode).toBe(200);
    // A's agent falls through to the engine's own default, not B's policy.
    expect(res.json().decision.policyId).not.toBe('pol_b_wide');

    // And the same policy DOES govern B's own agent.
    expect(engine.visiblePolicies({ orgId: ORG_B }).map((p) => p.policyId)).toContain('pol_b_wide');
    await app.close();
  });

  it('refuses a policy id already owned by another org', async () => {
    const { app, adminA, adminB, as } = await tenantWorld();
    const payload = { policyId: 'default', rules: [], default: 'allow' };
    const first = await app.inject({ method: 'POST', url: '/v1/policies', headers: as(adminA), payload });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({ method: 'POST', url: '/v1/policies', headers: as(adminB), payload });
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toBe('policy_id_taken');
    await app.close();
  });

  it('lists a global policy to everyone and a tenant policy to its owner only', async () => {
    const { app, root, adminA, readA, adminB, as } = await tenantWorld();
    await app.inject({
      method: 'POST',
      url: '/v1/policies',
      headers: as(root),
      payload: { policyId: 'pol_global', rules: [], default: 'allow' },
    });
    await app.inject({
      method: 'POST',
      url: '/v1/policies',
      headers: as(adminA),
      payload: { policyId: 'pol_a_only', rules: [], default: 'allow' },
    });

    const aSees = await app.inject({ method: 'GET', url: '/v1/policies', headers: as(readA) });
    expect(aSees.json().map((p: { policyId: string }) => p.policyId)).toEqual([
      'pol_global',
      'pol_a_only',
    ]);

    const bSees = await app.inject({ method: 'GET', url: '/v1/policies', headers: as(adminB) });
    expect(bSees.json().map((p: { policyId: string }) => p.policyId)).toEqual(['pol_global']);
    await app.close();
  });
});

describe('tenant isolation: spending and its record', () => {
  it('403s an evaluate for an agent outside the key’s scope', async () => {
    const { app, evalA, agentB, as } = await tenantWorld();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/evaluate',
      headers: as(evalA),
      payload: intent(agentB.id),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('agent_not_in_scope');
    await app.close();
  });

  it('403s an agent-narrowed key on a sibling agent in its own org', async () => {
    const { app, auth, engine, agentA, as } = await tenantWorld();
    const sibling = await engine.registerAgent({
      id: newId('agt'),
      orgId: ORG_A,
      name: 'a-2',
      createdAt: new Date(),
    });
    const runtime = await auth.issue({
      name: 'a-1-runtime',
      scopes: ['evaluate'],
      orgId: ORG_A,
      agentIds: [agentA.id],
    });

    const own = await app.inject({
      method: 'POST',
      url: '/v1/evaluate',
      headers: as(runtime),
      payload: intent(agentA.id),
    });
    expect(own.statusCode).toBe(200);

    const other = await app.inject({
      method: 'POST',
      url: '/v1/evaluate',
      headers: as(runtime),
      payload: intent(sibling.id),
    });
    expect(other.statusCode).toBe(403);
    await app.close();
  });

  it('shows each org only its own decisions, and hides unattributed ones from both', async () => {
    const { app, engine, evalA, readA, adminB, agentA, as } = await tenantWorld();
    await app.inject({
      method: 'POST',
      url: '/v1/evaluate',
      headers: as(evalA),
      payload: intent(agentA.id),
    });
    expect(engine.decisions()).toHaveLength(1);

    const aSees = await app.inject({ method: 'GET', url: '/v1/decisions', headers: as(readA) });
    expect(aSees.json()).toHaveLength(1);

    const bSees = await app.inject({ method: 'GET', url: '/v1/decisions', headers: as(adminB) });
    expect(bSees.json()).toEqual([]);
    await app.close();
  });

  it('404s a settlement report against an intent the caller does not own', async () => {
    const { app, evalA, adminB, agentA, as } = await tenantWorld();
    const evaluated = await app.inject({
      method: 'POST',
      url: '/v1/evaluate',
      headers: as(evalA),
      payload: intent(agentA.id),
    });
    const intentId = evaluated.json().intent.id;

    const foreign = await app.inject({
      method: 'POST',
      url: '/v1/settlements',
      headers: as(adminB),
      payload: { intentId, confirmedAt: new Date().toISOString() },
    });
    expect(foreign.statusCode).toBe(404);

    const own = await app.inject({
      method: 'POST',
      url: '/v1/settlements',
      headers: as(evalA),
      payload: { intentId, confirmedAt: new Date().toISOString() },
    });
    expect(own.statusCode).toBe(202);
    await app.close();
  });

  it('reconciles over owned allowances only', async () => {
    const { app, evalA, adminB, readA, root, agentA, as } = await tenantWorld();
    // An allowance needs an ALLOW: with no policy at all the engine fails
    // closed, and a denied intent writes no spend record to reconcile.
    await app.inject({
      method: 'POST',
      url: '/v1/policies',
      headers: as(root),
      payload: { policyId: 'pol_open', rules: [], default: 'allow' },
    });
    await app.inject({
      method: 'POST',
      url: '/v1/evaluate',
      headers: as(evalA),
      payload: intent(agentA.id, '0.25'),
    });

    const aSees = await app.inject({ method: 'GET', url: '/v1/reconciliation', headers: as(readA) });
    expect(aSees.json().allowed).toBe(1);
    expect(aSees.json().allowedValue).toBe('0.25');

    const bSees = await app.inject({ method: 'GET', url: '/v1/reconciliation', headers: as(adminB) });
    expect(bSees.json().allowed).toBe(0);
    expect(bSees.json().gaps).toEqual([]);
    await app.close();
  });
});

describe('tenant isolation: keys', () => {
  it('mints inside the caller’s org whatever the body asks for, and lists only its own', async () => {
    const { app, adminA, adminB, as } = await tenantWorld();
    const issued = await app.inject({
      method: 'POST',
      url: '/v1/keys',
      headers: as(adminA),
      payload: { name: 'planted', scopes: ['admin'], orgId: ORG_B },
    });
    expect(issued.statusCode).toBe(201);
    expect(issued.json().key.orgId).toBe(ORG_A);

    const aList = await app.inject({ method: 'GET', url: '/v1/keys', headers: as(adminA) });
    const aOrgs = aList.json().map((k: { orgId?: string }) => k.orgId);
    expect(new Set(aOrgs)).toEqual(new Set([ORG_A]));

    const bList = await app.inject({ method: 'GET', url: '/v1/keys', headers: as(adminB) });
    expect(bList.json().every((k: { orgId?: string }) => k.orgId === ORG_B)).toBe(true);
    await app.close();
  });

  it('refuses an org id that is a NAME rather than a prefixed ULID', async () => {
    // Onboarding an invited org means naming it in a key's orgId -- there is no
    // /v1/orgs route. It is tempting to name it `org_acme`, and S71's handoff
    // told the next session to do exactly that. OrgId is `org_` + a 26-char
    // Crockford body, so the first invitee would have been a 400 nobody
    // expected. The org id is GENERATED (`newId('org')`); the human-readable
    // name lives on the key.
    const { app, root, as } = await tenantWorld();
    const named = await app.inject({
      method: 'POST',
      url: '/v1/keys',
      headers: as(root),
      payload: { name: 'acme-admin', scopes: ['admin'], orgId: 'org_acme' },
    });
    expect(named.statusCode).toBe(400);

    const minted = await app.inject({
      method: 'POST',
      url: '/v1/keys',
      headers: as(root),
      payload: { name: 'acme-admin', scopes: ['admin'], orgId: newId('org') },
    });
    expect(minted.statusCode).toBe(201);
    await app.close();
  });

  /**
   * The narrowing has to hold on ROTATE, not only on issue.
   *
   * `POST /v1/keys` already refuses to mint a key wider than the caller --
   * "otherwise the narrowing would be one API call away from undone" -- and
   * rotate was that one API call. It answers with the replacement plaintext
   * secret, so an agent-narrowed admin could list its org's keys, rotate the
   * un-narrowed org admin key, and read the new secret out of the 200: full
   * spend authority over every agent in the org, which is the entire blast
   * radius the narrowing exists to contain. Revoke was the same hole pointed
   * at destruction instead.
   */
  it('404s rotate and revoke of a WIDER key in the caller’s own org', async () => {
    const { app, auth, adminA, agentA, as } = await tenantWorld();
    const narrowed = await auth.issue({
      name: 'a-agent-admin',
      scopes: ['admin'],
      orgId: ORG_A,
      agentIds: [agentA.id],
    });

    for (const path of ['rotate', 'revoke']) {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/keys/${adminA.key.id}/${path}`,
        headers: as(narrowed),
      });
      expect(res.statusCode, path).toBe(404);
    }

    // Its own key is still its own to rotate: this is a narrowing, not a
    // freeze, and the same 404 for both would make the rule unlearnable.
    const own = await app.inject({
      method: 'POST',
      url: `/v1/keys/${narrowed.key.id}/rotate`,
      headers: as(narrowed),
    });
    expect(own.statusCode).toBe(200);
    await app.close();
  });

  it('404s rotate and revoke on another org’s key, and on the unscoped root key', async () => {
    const { app, adminA, adminB, root, auth, as } = await tenantWorld();
    const rootId = auth.list().find((k) => k.name === 'operator')?.id;
    const bId = auth.list().find((k) => k.name === 'b-admin')?.id;

    const foreign = await app.inject({
      method: 'POST',
      url: `/v1/keys/${bId}/revoke`,
      headers: as(adminA),
    });
    expect(foreign.statusCode).toBe(404);

    const operator = await app.inject({
      method: 'POST',
      url: `/v1/keys/${rootId}/rotate`,
      headers: as(adminB),
      payload: {},
    });
    expect(operator.statusCode).toBe(404);

    // The operator key itself can still rotate anything.
    const allowed = await app.inject({
      method: 'POST',
      url: `/v1/keys/${bId}/rotate`,
      headers: as(root),
      payload: {},
    });
    expect(allowed.statusCode).toBe(200);
    await app.close();
  });

  it('refuses an agent-narrowed key that tries to mint something wider', async () => {
    const { app, auth, agentA, as } = await tenantWorld();
    const runtime = await auth.issue({
      name: 'narrow-admin',
      scopes: ['admin'],
      orgId: ORG_A,
      agentIds: [agentA.id],
    });

    const wider = await app.inject({
      method: 'POST',
      url: '/v1/keys',
      headers: as(runtime),
      payload: { name: 'wider', scopes: ['evaluate'] },
    });
    expect(wider.statusCode).toBe(403);
    expect(wider.json().error).toBe('agent_not_in_scope');

    const same = await app.inject({
      method: 'POST',
      url: '/v1/keys',
      headers: as(runtime),
      payload: { name: 'same', scopes: ['evaluate'], agentIds: [agentA.id] },
    });
    expect(same.statusCode).toBe(201);
    await app.close();
  });

  it('refuses at issuance to narrow a key to agents with no org', async () => {
    const auth = new ApiKeyAuth();
    await expect(
      auth.issue({ name: 'half-scoped', scopes: ['evaluate'], agentIds: [newId('agt')] }),
    ).rejects.toThrow(/orgId/);
  });
});

describe('tenant isolation: approvals', () => {
  async function escalatingWorld() {
    const world = await tenantWorld();
    await world.engine.addPolicy({
      policyId: 'pol_review',
      rules: [{ id: 'big', escalate: { amountGt: '0.05' } }],
      default: 'allow',
    });

    const keyOf = (name: string) => {
      const pair = generateKeyPairSync('ed25519');
      return {
        pair,
        pem: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
        name,
      };
    };
    const a = keyOf('finance-a');
    const b = keyOf('finance-b');
    const approverA = await world.approvals.registerApprover({
      orgId: ORG_A,
      name: a.name,
      publicKey: a.pem,
    });
    const approverB = await world.approvals.registerApprover({
      orgId: ORG_B,
      name: b.name,
      publicKey: b.pem,
    });

    const escalated = await world.app.inject({
      method: 'POST',
      url: '/v1/evaluate',
      headers: world.as(world.evalA),
      payload: intent(world.agentA.id, '5.00'),
    });
    return { ...world, a, b, approverA, approverB, escalation: escalated.json() };
  }

  it('stamps the parked request with the agent’s org and hides it from the other', async () => {
    const { app, readA, adminB, escalation, as } = await escalatingWorld();
    expect(escalation.decision.outcome).toBe('escalate');
    expect(escalation.approval.orgId).toBe(ORG_A);

    const aList = await app.inject({ method: 'GET', url: '/v1/approvals', headers: as(readA) });
    expect(aList.json()).toHaveLength(1);

    const bList = await app.inject({ method: 'GET', url: '/v1/approvals', headers: as(adminB) });
    expect(bList.json()).toEqual([]);

    const bPeek = await app.inject({
      method: 'GET',
      url: `/v1/approvals/${escalation.decision.id}`,
      headers: as(adminB),
    });
    expect(bPeek.statusCode).toBe(404);
    await app.close();
  });

  it('404s a foreign org’s attempt to resolve, before any signature is checked', async () => {
    const { app, adminB, b, approverB, escalation, as } = await escalatingWorld();
    const signature = signApproval(b.pair.privateKey, {
      decisionId: escalation.decision.id,
      intentHash: escalation.decision.intentHash,
      verdict: 'approve',
    });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/approvals/${escalation.decision.id}/resolve`,
      headers: as(adminB),
      payload: {
        intentHash: escalation.decision.intentHash,
        verdict: 'approve',
        approverKeyId: approverB.id,
        signature,
      },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('refuses a valid signature from another org’s approver, even on the root key', async () => {
    const { app, root, b, approverB, escalation, as } = await escalatingWorld();
    const signature = signApproval(b.pair.privateKey, {
      decisionId: escalation.decision.id,
      intentHash: escalation.decision.intentHash,
      verdict: 'approve',
    });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/approvals/${escalation.decision.id}/resolve`,
      headers: as(root),
      payload: {
        intentHash: escalation.decision.intentHash,
        verdict: 'approve',
        approverKeyId: approverB.id,
        signature,
      },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('approver_wrong_org');
    await app.close();
  });

  it('lets the right org’s approver release the payment', async () => {
    const { app, approveA, a, approverA, escalation, as } = await escalatingWorld();
    const signature = signApproval(a.pair.privateKey, {
      decisionId: escalation.decision.id,
      intentHash: escalation.decision.intentHash,
      verdict: 'approve',
    });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/approvals/${escalation.decision.id}/resolve`,
      headers: as(approveA),
      payload: {
        intentHash: escalation.decision.intentHash,
        verdict: 'approve',
        approverKeyId: approverA.id,
        signature,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().decision.outcome).toBe('allow');
    await app.close();
  });

  it('registers an approver into the caller’s org and lists only its own', async () => {
    const { app, adminA, adminB, as } = await escalatingWorld();
    const pem = generateKeyPairSync('ed25519')
      .publicKey.export({ type: 'spki', format: 'pem' })
      .toString();
    const created = await app.inject({
      method: 'POST',
      url: '/v1/approvers',
      headers: as(adminA),
      payload: { orgId: ORG_B, name: 'planted', publicKey: pem },
    });
    expect(created.json().orgId).toBe(ORG_A);

    const bList = await app.inject({ method: 'GET', url: '/v1/approvers', headers: as(adminB) });
    expect(bList.json().every((k: { orgId: string }) => k.orgId === ORG_B)).toBe(true);

    const revokeForeign = await app.inject({
      method: 'POST',
      url: `/v1/approvers/${created.json().id}/revoke`,
      headers: as(adminB),
    });
    expect(revokeForeign.statusCode).toBe(404);
    await app.close();
  });
});

describe('tenant isolation: the scope primitives', () => {
  const agent = (orgId: string, id = newId('agt')) => ({
    id,
    orgId,
    name: 'a',
    labels: [],
    wallets: [],
    status: 'active' as const,
    createdAt: new Date(),
  });

  it('reads no scope from a key with no org — the operator/self-hoster case', () => {
    expect(scopeOf({ orgId: undefined, agentIds: undefined })).toBeUndefined();
    expect(ownsAgent(undefined, undefined)).toBe(true);
  });

  it('refuses to resolve a key that names agents but no org, rather than widening it', () => {
    // Unmintable through `issue()`, so this is about a row that arrived some
    // other way: treating it as unscoped would promote the most confined key
    // in the system to the least confined one.
    expect(() => scopeOf({ orgId: undefined, agentIds: [newId('agt')] })).toThrow(
      /cannot be scoped/,
    );
  });

  it('never owns an unregistered agent — no org must not read as any org', () => {
    const scope = { orgId: ORG_A };
    expect(ownsAgent(scope, undefined)).toBe(false);
    expect(ownsAgent(scope, agent(ORG_A))).toBe(true);
    expect(ownsAgent(scope, agent(ORG_B))).toBe(false);
  });

  it('hides an unstamped row from every tenant and shows it to the operator', () => {
    expect(ownsOrg({ orgId: ORG_A }, undefined)).toBe(false);
    expect(ownsOrg(undefined, undefined)).toBe(true);
  });
});

describe('tenant isolation: a tenant never has to name its own org', () => {
  it('registers an agent and an approver with no orgId in the body', async () => {
    const { app, adminA, as } = await tenantWorld();
    const agent = await app.inject({
      method: 'POST',
      url: '/v1/agents',
      headers: as(adminA),
      payload: { name: 'no-org-named' },
    });
    expect(agent.statusCode).toBe(200);
    expect(agent.json().orgId).toBe(ORG_A);

    const pem = generateKeyPairSync('ed25519')
      .publicKey.export({ type: 'spki', format: 'pem' })
      .toString();
    const approver = await app.inject({
      method: 'POST',
      url: '/v1/approvers',
      headers: as(adminA),
      payload: { name: 'on-call', publicKey: pem },
    });
    expect(approver.statusCode).toBe(201);
    expect(approver.json().orgId).toBe(ORG_A);
    await app.close();
  });

  it('still makes the unscoped operator key say which org an agent is in', async () => {
    const { app, root, as } = await tenantWorld();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/agents',
      headers: as(root),
      payload: { name: 'orphan' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('validation_error');
    await app.close();
  });
});
