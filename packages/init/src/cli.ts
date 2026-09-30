import { InitError, runInit, DEFAULT_ENGINE_URL } from './index.js';

const HELP = `npx @reinconsole/init [options]

Creates a Rein sandbox (testnet, no account, expires in 7 days), writes
rein-agent.json here, then makes one allowed payment and one refused one.

  --engine <url>   engine to use (default ${DEFAULT_ENGINE_URL}, or $REIN_ENGINE_URL)
  --vendor <url>   x402 vendor for the demo calls (default https://vendor.reinconsole.com)
  --force          mint a new sandbox even if rein-agent.json exists
  --no-demo        write rein-agent.json and stop
  -h, --help       this text`;

export async function main(argv: string[]): Promise<number> {
  const opts: Parameters<typeof runInit>[0] = {};
  const envEngine = process.env['REIN_ENGINE_URL'];
  if (envEngine) opts.engineUrl = envEngine;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new InitError(`${arg} needs a value`);
      return v;
    };
    if (arg === '-h' || arg === '--help') {
      console.log(HELP);
      return 0;
    } else if (arg === '--engine') opts.engineUrl = value();
    else if (arg === '--vendor') opts.vendorUrl = value();
    else if (arg === '--force') opts.force = true;
    else if (arg === '--no-demo') opts.noDemo = true;
    else {
      console.error(`unknown option ${arg}\n\n${HELP}`);
      return 2;
    }
  }
  try {
    await runInit(opts);
    return 0;
  } catch (err) {
    console.error(`\n[rein] ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
