import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { newId } from '@reinconsole/core';
import { ConfigError, configFromEnv } from './config.js';

function agentFile(contents: unknown): string {
  const path = join(mkdtempSync(join(tmpdir(), 'rein-agent-')), 'rein-agent.json');
  writeFileSync(path, typeof contents === 'string' ? contents : JSON.stringify(contents));
  return path;
}

describe('REIN_AGENT_FILE (what npx @reinconsole/init writes)', () => {
  const agentId = newId('agt');
  const file = {
    engineUrl: 'https://engine.reinconsole.com',
    agentId,
    apiKey: 'rk_fromfile',
    network: 'base-sepolia',
    wallet: { address: '0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A', privateKey: `0x${'22'.repeat(32)}` },
  };

  it('reads the engine, agent, key and payer from the file', async () => {
    const config = await configFromEnv({ REIN_AGENT_FILE: agentFile(file) });
    expect(config.engineUrl).toBe(file.engineUrl);
    expect(config.agentId).toBe(agentId);
    expect(config.apiKey).toBe('rk_fromfile');
    expect(config.payer).toBeDefined();
    expect(config.networkProfile).toBe('testnet');
  });

  it('lets an explicit variable override one field', async () => {
    const config = await configFromEnv({
      REIN_AGENT_FILE: agentFile(file),
      REIN_ENGINE_URL: 'http://127.0.0.1:8787',
    });
    expect(config.engineUrl).toBe('http://127.0.0.1:8787');
    expect(config.agentId).toBe(agentId);
  });

  it('a missing or broken file is a ConfigError, not a stack', async () => {
    await expect(configFromEnv({ REIN_AGENT_FILE: join(tmpdir(), 'no-such-rein-agent.json') })).rejects.toBeInstanceOf(
      ConfigError,
    );
    await expect(configFromEnv({ REIN_AGENT_FILE: agentFile('{nope') })).rejects.toThrow(/not JSON/);
  });
});
