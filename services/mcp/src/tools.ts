import { z } from 'zod';
import { globMatchAny, type Agent, type Policy } from '@reinconsole/core';
import {
  EngineClient,
  EngineError,
  PaymentBlockedError,
  type Guard,
  type Receipt,
} from '@reinconsole/sdk';
import type { ResolvedMcpConfig } from './config.js';

/**
 * What a tool hands back. A structural subset of MCP's `CallToolResult`, kept
 * local so the tool surface -- the part with the design decisions in it -- can
 * be tested without a transport, a client, or the protocol SDK.
 */
export interface ToolResult {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

/** One tool, transport-agnostic: `registerTools` binds these onto an MCP server. */
export interface ReinTool {
  name: string;
  title: string;
  description: string;
  inputSchema: z.ZodRawShape;
  annotations: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
  handler: (args: Record<string, unknown>) => Promise<ToolResult>;
}

export interface ReinToolContext {
  guard: Guard;
  client: EngineClient;
  config: ResolvedMcpConfig;
}

/**
 * The Rein tool surface, and its one governing rule:
 *
 *   The client on the other end of this pipe IS THE AGENT -- the thing being
 *   governed. So a tool may do anything the agent could already do with its
 *   own fetch, and NOTHING that widens the agent's own authority.
 *
 * Which is why there is no tool here to approve an escalation, add or edit a
 * policy, freeze or unfreeze an agent, issue or rotate an API key, or register
 * an approver. An approval is a SIGNATURE over the decision (A2); a tool call
 * is not a signature, and a tool that stood in for one would be the
 * click-to-approve path the whole approval design exists to refuse -- with the
 * authority to move money sitting behind whatever process holds the pipe.
 * `rein_escalations` is therefore READ-ONLY by construction, exactly like the
 * console panel (B3). `tools.test.ts` pins this: it asserts the whole surface,
 * not a sample of it, so adding an authority tool has to break a test first.
 *
 * `readOnlyHint` makes the same boundary legible to the HARNESS rather than
 * only to a reader: `rein_fetch` is the only tool that can move money, and it
 * is the only one that does not carry the hint.
 */
export function reinTools(ctx: ReinToolContext): ReinTool[] {
  return [
    fetchTool(ctx),
    statusTool(ctx),
    receiptsTool(ctx),
    escalationsTool(ctx),
    heartbeatTool(ctx),
  ];
}

// -- rein_fetch --------------------------------------------------------------

function fetchTool(ctx: ReinToolContext): ReinTool {
  const { guard, config } = ctx;
  return {
    name: 'rein_fetch',
    title: 'Fetch a URL under Rein spend policy',
    description:
      'HTTP fetch with x402 payments governed by Rein. If the resource is behind a paywall, ' +
      'the payment is checked against policy BEFORE any money moves: allowed payments are ' +
      'settled and receipted, denied ones never happen, and payments past an envelope are ' +
      'escalated to a human for a signed approval. Use this instead of a plain fetch for any ' +
      'request that might be paid. Returns the response plus what Rein decided.',
    inputSchema: {
      url: z.string().url().describe('Absolute URL to fetch.'),
      method: z
        .enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'])
        .optional()
        .describe('HTTP method. Default GET.'),
      headers: z.record(z.string()).optional().describe('Extra request headers.'),
      body: z.string().optional().describe('Request body, already serialized.'),
      taskId: z
        .string()
        .optional()
        .describe(
          'Attributes this spend to a unit of work, so per-task budgets can cap it. ' +
            'Use one id for every payment of one job.',
        ),
    },
    // The one tool that can move money: no readOnlyHint, and openWorld because
    // it reaches arbitrary vendors.
    annotations: { readOnlyHint: false, openWorldHint: true },
    handler: async (args) => {
      const url = String(args['url']);
      const method = typeof args['method'] === 'string' ? args['method'] : 'GET';
      const init: RequestInit = { method };
      if (args['headers'] !== undefined && args['headers'] !== null) {
        init.headers = args['headers'] as Record<string, string>;
      }
      if (typeof args['body'] === 'string') init.body = args['body'];

      const taskId = typeof args['taskId'] === 'string' ? args['taskId'] : config.taskId;
      // Identity, not index: the receipt log is capped and evicts from the
      // front, so a position remembered before the call can point at the
      // wrong receipt after it. One guarded call records at most one.
      const lastBefore = guard.receipts().at(-1);
      const wrapped = guard.wrap();
      const call = (): Promise<Response> => wrapped(url, init);

      let res: Response;
      try {
        res = await (taskId !== undefined ? guard.withTask({ taskId }, call) : call());
      } catch (err) {
        if (err instanceof PaymentBlockedError) return blocked(err);
        return errorResult(
          `Request to ${url} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      const lastAfter = guard.receipts().at(-1);
      const receipt = lastAfter !== lastBefore ? lastAfter : undefined;
      const { body, truncated } = await readBody(res, config.maxBodyBytes);

      // Advisory mode: policy ALLOWED the payment but no payer is configured,
      // so the guard released the 402 upward unpaid. Reporting the 402 without
      // saying why would read as a denial, which is the opposite of what
      // happened.
      const advisory =
        res.status === 402 && receipt?.outcome === 'allow' && config.payer === undefined;

      return ok(
        json({
          status: res.status,
          url,
          ...(advisory
            ? {
                rein: 'ALLOWED_BUT_UNPAID',
                note:
                  'Rein allowed this payment, but this server runs in advisory mode (no payer ' +
                  'configured), so the paywall was not paid and the 402 is returned as-is. ' +
                  'Set REIN_PAYER_PRIVATE_KEY to settle payments.',
              }
            : {}),
          ...(receipt
            ? { rein_receipt: receiptView(receipt) }
            : { rein: 'no payment was involved in this request' }),
          contentType: res.headers.get('content-type') ?? undefined,
          bodyTruncated: truncated ? `body exceeded ${config.maxBodyBytes} bytes` : undefined,
          body,
        }),
      );
    },
  };
}

/**
 * A policy block is reported as a tool ERROR: the fetch did not happen, and a
 * model reading this as an ordinary result would treat the explanation of a
 * refusal as the data it asked for. The detail still rides along, because the
 * useful next move (wait for a human, pick a cheaper vendor, give up) depends
 * on WHICH refusal this was.
 */
function blocked(err: PaymentBlockedError): ToolResult {
  const { decision, intent, approval, receipt } = err;
  const escalated = decision.outcome === 'escalate';
  return errorResult(
    json({
      rein: escalated ? 'ESCALATED' : 'DENIED',
      reason: decision.reason,
      guidance: escalated
        ? 'A human must sign an approval for this payment. It is parked, not refused: poll ' +
          'rein_escalations, or do something else and come back. Nothing you can send will ' +
          'approve it.'
        : 'Policy refused this payment. The same request will be refused the same way; a ' +
          'different vendor, a smaller amount, or a human changing the policy is the remedy.',
      amount: `${intent.amount} ${intent.asset}`,
      vendor: intent.vendor.host,
      resource: intent.resource,
      decisionId: decision.id,
      intentId: intent.id,
      ...(approval
        ? {
            approval: {
              status: approval.status,
              expiresAt: approval.expiresAt.toISOString(),
              breakers: approval.breakers,
            },
          }
        : {}),
      ...(receipt ? { receiptId: receipt.id } : {}),
    }),
  );
}

// -- rein_status -------------------------------------------------------------

function statusTool(ctx: ReinToolContext): ReinTool {
  const { client, config } = ctx;
  return {
    name: 'rein_status',
    title: 'What governs this agent, and where it stands',
    description:
      'The rules this agent is subject to and its standing against them: engine posture, ' +
      'agent status, the policies that apply, spend-breaker counters (how close this agent ' +
      'is to tripping an envelope), and liveness. Read it before a large or unusual payment, ' +
      'or after a denial, to find out what the limits actually are.',
    inputSchema: {},
    annotations: { readOnlyHint: true },
    handler: async () => {
      // Each read is attempted independently: an API key carrying only
      // `evaluate` scope still gets a useful answer, and the parts it could not
      // read say so instead of failing the whole call.
      const [health, agents, policies, breakers, liveness] = await Promise.all([
        attempt(() => client.health()),
        attempt(() => client.listAgents()),
        attempt(() => client.listPolicies()),
        attempt(() => client.breakerStates(config.agentId)),
        attempt(() => client.liveness()),
      ]);

      const me = agents.ok ? agents.value.find((a) => a.id === config.agentId) : undefined;

      return ok(
        json({
          agentId: config.agentId,
          mode:
            config.payer !== undefined
              ? 'settling (a payer is configured)'
              : 'advisory (no payer configured)',
          // Which money this is. An agent that cannot tell testnet from
          // mainnet cannot reason about the size of what it is about to do,
          // and the engine's own view folds the two together (policy is
          // written about chains, not deployments).
          network: config.networkProfile,
          engine: health.ok
            ? {
                status: health.value.status,
                auth: health.value.auth,
                approvals: health.value.approvals,
              }
            : unavailable(health.error),
          agent: agents.ok
            ? me
              ? { name: me.name, status: me.status, labels: me.labels }
              : 'NOT REGISTERED with this engine -- every payment fails closed'
            : unavailable(agents.error),
          policies: policies.ok
            ? policies.value.filter((p) => policyApplies(p, config.agentId, me)).map(policyView)
            : unavailable(policies.error),
          breakers: breakers.ok
            ? breakers.value.map((b) => ({
                id: b.breaker.id,
                window: b.breaker.window,
                txCount:
                  b.breaker.txCount !== undefined
                    ? `${b.txCount} / ${b.breaker.txCount}`
                    : String(b.txCount),
                spend:
                  b.breaker.valueCap !== undefined ? `${b.sum} / ${b.breaker.valueCap}` : b.sum,
                tripped: b.tripped,
                ...(b.reason !== undefined ? { reason: b.reason } : {}),
              }))
            : unavailable(breakers.error),
          liveness: liveness.ok
            ? livenessView(liveness.value, config.agentId)
            : unavailable(liveness.error),
        }),
      );
    },
  };
}

/**
 * Which policies bind THIS agent -- the same targeting the engine applies,
 * minus the chain leg (an agent is not on one chain). Reported to the agent as
 * "the rules over you", so including a policy it is not subject to would be
 * misinformation rather than merely noise.
 */
function policyApplies(policy: Policy, agentId: string, agent: Agent | undefined): boolean {
  const { agents, labels } = policy.appliesTo;
  if (agents === undefined && labels === undefined) return true;
  if (agents !== undefined && globMatchAny(agents, agentId)) return true;
  // A labels-targeted policy needs the agent DOCUMENT: an unregistered agent
  // matches nothing here, and fails closed on the engine side for the same reason.
  if (labels !== undefined && agent !== undefined) {
    return agent.labels.some((label) => globMatchAny(labels, label));
  }
  return false;
}

function policyView(policy: Policy): unknown {
  return {
    policyId: policy.policyId,
    version: policy.version,
    default: policy.default,
    rules: policy.rules.map((rule) => {
      const action =
        rule.allow !== undefined ? 'allow' : rule.deny !== undefined ? 'deny' : 'escalate';
      return { id: rule.id, [action]: rule.allow ?? rule.deny ?? rule.escalate };
    }),
    breakers: policy.breakers,
  };
}

interface LivenessLike {
  agentId: string;
  status: string;
  silentMs: number;
  dueAt: number;
}

function livenessView(states: LivenessLike[], agentId: string): unknown {
  const mine = states.find((s) => s.agentId === agentId);
  // An expectation is DECLARED, never inferred (B2): no state means nobody is
  // watching this agent, which is not the same thing as healthy.
  if (mine === undefined) {
    return 'not watched -- no activity expectation is declared for this agent';
  }
  return {
    status: mine.status,
    silentForMs: mine.silentMs,
    nextExpectedBy: new Date(mine.dueAt).toISOString(),
    ...(mine.status === 'unknown'
      ? {
          note: 'unknown is NOT an alarm: the engine restarted and has not witnessed this silence',
        }
      : {}),
  };
}

// -- rein_receipts -----------------------------------------------------------

function receiptsTool(ctx: ReinToolContext): ReinTool {
  const { guard, client, config } = ctx;
  return {
    name: 'rein_receipts',
    title: 'What this agent has paid, and whether it settled',
    description:
      "This session's Rein receipts (every payment decision this server made, allowed or not) " +
      'plus reconciliation: which allowed payments actually settled and which are still ' +
      'outstanding. Use it to check whether a payment really went through.',
    inputSchema: {
      limit: z
        .number()
        .int()
        .positive()
        .max(200)
        .optional()
        .describe('Most recent N receipts. Default 20.'),
      window: z.string().optional().describe("Reconciliation window, e.g. '24h'. Default 24h."),
    },
    annotations: { readOnlyHint: true },
    handler: async (args) => {
      const limit = typeof args['limit'] === 'number' ? args['limit'] : 20;
      const window = typeof args['window'] === 'string' ? args['window'] : '24h';
      const all = guard.receipts();
      const report = await attempt(() =>
        client.reconciliation({ window, agentId: config.agentId }),
      );

      return ok(
        json({
          sessionReceiptCount: all.length,
          sessionReceipts: all.slice(-limit).map(receiptView),
          reconciliation: report.ok
            ? {
                window: report.value.window,
                allowed: report.value.allowed,
                allowedValue: report.value.allowedValue,
                settled: report.value.settled,
                inFlight: report.value.inFlight,
                unsettled: report.value.unsettled,
                // Settled for MORE than the decision allowed. The one number
                // here that is a breach rather than a doubt, so it is never
                // folded into the others.
                overspent: report.value.overspent ?? 0,
                overspentValue: report.value.overspentValue ?? '0',
                gaps: report.value.gaps,
                // The B1 honesty valve: with nobody reporting settlements, every
                // allowance reads as a gap. That says something about the
                // deployment's wiring, not about its payments.
                ...(report.value.settlementsSeen === 0
                  ? {
                      note:
                        'This engine has never been told about a settlement, so "unsettled" ' +
                        'here reflects missing reporting, not missing money.',
                    }
                  : {}),
              }
            : unavailable(report.error),
        }),
      );
    },
  };
}

// -- rein_escalations --------------------------------------------------------

function escalationsTool(ctx: ReinToolContext): ReinTool {
  const { client, config } = ctx;
  return {
    name: 'rein_escalations',
    title: 'Payments parked awaiting a human approval',
    description:
      'Payments by this agent that policy escalated rather than allowed or denied. Each is ' +
      'waiting for a human to sign an approval and expires into a denial if nobody does. ' +
      'READ-ONLY: an approval is a cryptographic signature by a registered approver, and ' +
      'nothing callable here can grant, deny or extend one.',
    inputSchema: {},
    annotations: { readOnlyHint: true },
    handler: async () => {
      const pending = await attempt(() => client.pendingApprovals());
      if (!pending.ok) {
        // `/v1/approvals` answers 404 for exactly one reason.
        const noTier = pending.cause instanceof EngineError && pending.cause.status === 404;
        // A THIRD honesty state, alongside "no approver registered" below. An
        // engine with no approval tier cannot park anything: its policies can
        // only allow or deny, and an `escalate` outcome there would block for
        // good with nothing in existence able to release it. Reporting that as
        // a transient "unavailable" would invite an agent to keep polling a
        // queue that can never have anything in it.
        if (noTier) {
          return ok(
            json({
              escalations:
                'NOT SUPPORTED by this engine -- it runs no approval tier, so no payment of ' +
                'yours can be parked for a human. Policy here only allows or denies.',
            }),
          );
        }
        return ok(json({ pending: unavailable(pending.error) }));
      }
      const approvers = await attempt(() => client.listApprovers());

      return ok(
        json({
          pending: pending.value
            .filter((r) => r.agentId === config.agentId)
            .map((r) => ({
              decisionId: r.decisionId,
              intentId: r.intentId,
              amount: `${r.amount} ${r.asset}`,
              vendor: r.vendorHost,
              resource: r.resource,
              reason: r.reason,
              breakers: r.breakers,
              expiresAt: r.expiresAt.toISOString(),
              expiresInMs: Math.max(0, r.expiresAt.getTime() - Date.now()),
            })),
          // The honesty valve (B3): a parked payment with no registered key is
          // awaiting an EXPIRY, not a human. Telling an agent to "wait for the
          // approval" in that state would be advice to wait forever.
          approvers: approvers.ok
            ? approvers.value.length === 0
              ? 'NONE registered -- nobody can sign these, so they will expire into denials'
              : approvers.value.map((a) => ({ keyId: a.id, name: a.name }))
            : unavailable(approvers.error),
        }),
      );
    },
  };
}

// -- rein_heartbeat ----------------------------------------------------------

function heartbeatTool(ctx: ReinToolContext): ReinTool {
  const { client, config } = ctx;
  return {
    name: 'rein_heartbeat',
    title: 'Report this agent as alive',
    description:
      'Tell Rein this agent is still working, for dead-man monitoring. Only needed when the ' +
      'agent is running but not buying anything -- every rein_fetch is already a sighting. ' +
      'Refused when no activity expectation is declared for this agent.',
    inputSchema: {
      note: z.string().max(200).optional().describe('What the agent is doing, for the operator.'),
    },
    // Not read-only (it writes a sighting) but it widens nothing: an agent able
    // to make this call is, by construction, exactly as alive as it claims.
    annotations: { readOnlyHint: false, idempotentHint: true },
    handler: async (args) => {
      const note = typeof args['note'] === 'string' ? args['note'] : undefined;
      try {
        const state = await client.heartbeat(config.agentId, note !== undefined ? { note } : {});
        return ok(
          json({
            acknowledged: true,
            status: state.status,
            nextExpectedBy: new Date(state.dueAt).toISOString(),
          }),
        );
      } catch (err) {
        // B2 pins this as a REFUSAL, not a no-op: an agent that believes it is
        // monitored when it is not is the exact failure dead-man watching exists
        // to prevent.
        return errorResult(
          `Heartbeat refused: ${err instanceof Error ? err.message : String(err)}. ` +
            'Most likely no activity expectation is declared for this agent, in which case ' +
            'nothing is watching for its silence.',
        );
      }
    },
  };
}

// -- shared ------------------------------------------------------------------

function receiptView(receipt: Receipt): unknown {
  return {
    id: receipt.id,
    outcome: receipt.outcome,
    amount: `${receipt.amount} ${receipt.asset}`,
    vendor: receipt.vendorHost,
    url: receipt.url,
    reason: receipt.reason,
    intentId: receipt.intentId,
    settled: receipt.settlement !== undefined,
    ...(receipt.settlement?.txHash !== undefined ? { txHash: receipt.settlement.txHash } : {}),
    at: receipt.createdAt.toISOString(),
  };
}

/**
 * A read that is allowed to fail on its own. `cause` is kept alongside the
 * message because some failures are ANSWERS -- a 404 from the approvals route
 * means this engine has no approval tier, which is a fact about the deployment
 * rather than an outage.
 */
type Attempt<T> = { ok: true; value: T } | { ok: false; error: string; cause: unknown };

async function attempt<T>(fn: () => Promise<T>): Promise<Attempt<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), cause: err };
  }
}

function unavailable(error: string): string {
  return `unavailable: ${error}`;
}

async function readBody(
  res: Response,
  maxBytes: number,
): Promise<{ body: string; truncated: boolean }> {
  const text = await res.text().catch(() => '');
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return { body: text, truncated: false };
  return {
    body: Buffer.from(text, 'utf8').subarray(0, maxBytes).toString('utf8'),
    truncated: true,
  };
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function ok(text: string): ToolResult {
  return { content: [{ type: 'text', text }] };
}

function errorResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}
