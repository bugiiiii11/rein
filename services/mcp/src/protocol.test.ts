import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { newId } from '@reinconsole/core';
import { createReinMcpServer, SERVER_NAME } from './index.js';

/**
 * The tool handlers are exercised in `tools.test.ts`. This file covers the
 * layer above them -- the actual protocol -- by driving a real MCP client
 * through `initialize`, `tools/list` and `tools/call`. Without it, a broken
 * schema conversion or a mis-shaped result would pass every handler test and
 * still leave the server useless to the harnesses C1 exists to reach.
 */
async function connect() {
  const server = createReinMcpServer({
    engineUrl: 'http://127.0.0.1:1',
    agentId: newId('agt'),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-harness', version: '0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return { client, close: () => Promise.all([client.close(), server.close()]) };
}

describe('the MCP protocol surface', () => {
  it('completes a handshake and advertises the whole tool list to a client', async () => {
    const { client, close } = await connect();

    expect(client.getServerVersion()?.name).toBe(SERVER_NAME);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'rein_escalations',
      'rein_fetch',
      'rein_heartbeat',
      'rein_receipts',
      'rein_status',
    ]);

    // The authority boundary has to survive the trip through the protocol: a
    // harness decides what to auto-approve from these hints, so they are part
    // of the contract, not documentation.
    const readOnly = tools.filter((t) => t.annotations?.readOnlyHint === true).map((t) => t.name);
    expect(readOnly.sort()).toEqual(['rein_escalations', 'rein_receipts', 'rein_status']);

    await close();
  });

  it('converts the zod input schemas into usable JSON Schema', async () => {
    const { client, close } = await connect();
    const { tools } = await client.listTools();
    const fetchTool = tools.find((t) => t.name === 'rein_fetch');

    const properties = fetchTool?.inputSchema.properties as Record<string, unknown> | undefined;
    expect(Object.keys(properties ?? {}).sort()).toEqual([
      'body',
      'headers',
      'method',
      'taskId',
      'url',
    ]);
    expect(fetchTool?.inputSchema.required).toEqual(['url']);

    await close();
  });

  it('carries a tool error back to the client as a result, not a thrown request', async () => {
    const { client, close } = await connect();

    // The engine is unreachable, so the fetch fails -- and `isError` is how a
    // model learns the request did not happen. A protocol-level exception would
    // instead read to the harness as a broken server.
    const result = await client.callTool({
      name: 'rein_fetch',
      arguments: { url: 'http://127.0.0.1:1/anything' },
    });
    expect(result.isError).toBe(true);

    await close();
  });
});
