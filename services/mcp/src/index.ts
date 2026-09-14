/**
 * @reinconsole/mcp -- the Guard, as an MCP server.
 *
 * Point any MCP-capable harness (Claude Code, Codex-class agents, anything
 * speaking the protocol) at this and its agent gets a spend-governed fetch:
 * every x402 paywall is policy-checked, receipted and observable before a cent
 * moves, plus read-only introspection of the rules it is subject to.
 *
 * The authority boundary is the design (see `tools.ts`): the client on the
 * other end of the pipe IS the agent, so no tool here can widen the agent's own
 * authority -- no approving an escalation, no editing a policy, no unfreezing,
 * no minting a key.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createGuard, type Guard } from '@reinconsole/sdk';
import { resolveConfig, type ReinMcpConfig, type ResolvedMcpConfig } from './config.js';
import { reinTools, type ReinTool, type ReinToolContext } from './tools.js';

export { configFromEnv, resolveConfig, ConfigError, DEFAULT_MAX_BODY_BYTES } from './config.js';
export type { ReinMcpConfig, ResolvedMcpConfig } from './config.js';
export { reinTools } from './tools.js';
export type { ReinTool, ReinToolContext, ToolResult } from './tools.js';

/** The server name harnesses show next to each tool. */
export const SERVER_NAME = 'rein';
export const SERVER_VERSION = '0.1.1';

/**
 * Build the guard and the tool context this server runs on. Exposed separately
 * from the MCP wiring so the tool surface can be driven directly in tests.
 */
export function createToolContext(config: ReinMcpConfig): ReinToolContext {
  const resolved: ResolvedMcpConfig = resolveConfig(config);
  const guard: Guard = createGuard({
    engineUrl: resolved.engineUrl,
    agentId: resolved.agentId,
    ...(resolved.apiKey !== undefined ? { apiKey: resolved.apiKey } : {}),
    ...(resolved.payer !== undefined ? { payer: resolved.payer } : {}),
    ...(resolved.fetch !== undefined ? { fetch: resolved.fetch } : {}),
    ...(resolved.taskId !== undefined ? { taskContext: { taskId: resolved.taskId } } : {}),
    // Blocks surface as a thrown PaymentBlockedError, which `rein_fetch` turns
    // into an MCP tool error -- the honest shape for "the fetch did not happen".
    onBlocked: 'throw',
    // Waiting is opt-in and bounded: an escalation TTL runs for hours and a
    // harness's tool timeout for seconds, so the default is to return the
    // parked request immediately and let the agent poll or move on.
    ...(resolved.escalationWaitMs > 0
      ? { escalation: { await: true, timeoutMs: resolved.escalationWaitMs } }
      : {}),
  });
  return { guard, client: guard.client, config: resolved };
}

/** Bind a tool list onto an MCP server. */
export function registerTools(server: McpServer, tools: ReinTool[]): void {
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: tool.annotations,
      },
      // The cast is the protocol boundary in both directions: the SDK hands the
      // handler parsed args, and expects back a `CallToolResult` whose open
      // index signature `ToolResult` deliberately does not have -- keeping the
      // tool surface a closed, assertable shape for its own tests.
      async (args: unknown) =>
        (await tool.handler((args ?? {}) as Record<string, unknown>)) as CallToolResult,
    );
  }
}

/** The whole server, ready to `connect()` to a transport. */
export function createReinMcpServer(config: ReinMcpConfig): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        "Rein governs this agent's spending. Use rein_fetch for any request that might hit " +
        'a paywall -- it checks policy before money moves and returns a receipt. If a ' +
        'payment is DENIED, do not retry it unchanged. If it is ESCALATED, a human must ' +
        'sign an approval: poll rein_escalations or move on, because nothing you can call ' +
        'will approve it yourself. rein_status shows the limits you are under.',
    },
  );
  registerTools(server, reinTools(createToolContext(config)));
  return server;
}
