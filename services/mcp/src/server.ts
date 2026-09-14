/**
 * The stdio entry point: `rein-mcp`, or `npx @reinconsole/mcp`.
 *
 * A harness spawns this and speaks MCP over the pipe, so STDOUT BELONGS TO THE
 * PROTOCOL. Anything else written there is a framing error that shows up as a
 * mysteriously dead server, which is why every message below goes to stderr --
 * harnesses surface stderr as the server's log.
 *
 * Config comes from the environment, the way an MCP client's config block
 * supplies it:
 *
 *   {
 *     "mcpServers": {
 *       "rein": {
 *         "command": "npx",
 *         "args": ["-y", "@reinconsole/mcp"],
 *         "env": {
 *           "REIN_ENGINE_URL": "http://127.0.0.1:8787",
 *           "REIN_AGENT_ID": "agt_..."
 *         }
 *       }
 *     }
 *   }
 */

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ConfigError, configFromEnv } from './config.js';
import { SERVER_VERSION, createReinMcpServer } from './index.js';

export async function main(): Promise<void> {
  let config;
  try {
    config = await configFromEnv();
  } catch (err) {
    if (err instanceof ConfigError) {
      // Fail closed and loudly at boot, in the same spirit as the engine's
      // refusal to bind publicly without a key: a half-configured guard that
      // starts anyway is a guard that silently governs nothing.
      console.error(`[rein-mcp] ${err.message}`);
      console.error('[rein-mcp] Required: REIN_ENGINE_URL, REIN_AGENT_ID.');
      console.error(
        '[rein-mcp] Optional: REIN_ENGINE_API_KEY, REIN_PAYER_PRIVATE_KEY (omit for advisory ' +
          'mode -- policy is checked, nothing is paid), REIN_MCP_TASK_ID, ' +
          'REIN_MCP_ESCALATION_WAIT_MS, REIN_MCP_MAX_BODY_BYTES.',
      );
      process.exit(1);
    }
    throw err;
  }

  let server;
  try {
    server = createReinMcpServer(config);
  } catch (err) {
    // Same reasoning as the config checks: a stack trace on stderr is all a
    // harness shows, so anything that stops the server from existing gets one
    // clean line instead.
    console.error(`[rein-mcp] cannot start: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  await server.connect(new StdioServerTransport());
  console.error(
    `[rein-mcp] ${SERVER_VERSION} ready on stdio for ${config.agentId} via ${config.engineUrl} ` +
      `(${config.payer !== undefined ? 'settling' : 'advisory -- no payer configured'})`,
  );
}

// Start when run directly (tsx/node/bin shim), not when imported.
function isMainModule(): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  await main();
}
