import { runApprove, runClaim, runInit, runMainnet, DEFAULT_ENGINE_URL } from './index.js';

const HELP = `npx @reinconsole/init [options]

Creates a Rein sandbox (testnet, no account, expires in 7 days), writes
rein-agent.json here, then makes one allowed payment and one refused one.

  --engine <url>        engine to use (default ${DEFAULT_ENGINE_URL}, or $REIN_ENGINE_URL)
  --vendor <url>        x402 vendor for the demo calls (default https://vendor.reinconsole.com)
  --force               mint a new sandbox even if rein-agent.json exists
  --no-demo             write rein-agent.json and stop
  --claim               keep this sandbox: sign in (GitHub or Ethereum) in the browser
  --mainnet             move a claimed org's agent to Base mainnet (real USDC)
  --approve <decision>  answer an escalation with your approver key (add --yes to sign)
  --reject <decision>   the same, refusing it
  -h, --help            this text`;

export async function main(argv: string[]): Promise<number> {
  const opts: Parameters<typeof runInit>[0] = {};
  let mode: 'init' | 'claim' | 'mainnet' | 'approve' = 'init';
  let decisionId = '';
  let verdict: 'approve' | 'reject' = 'approve';
  let yes = false;
  const envEngine = process.env['REIN_ENGINE_URL'];
  if (envEngine) opts.engineUrl = envEngine;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    let missing = false;
    const value = (): string => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) missing = true;
      return v ?? '';
    };
    if (arg === '-h' || arg === '--help') {
      console.log(HELP);
      return 0;
    } else if (arg === '--engine') opts.engineUrl = value();
    else if (arg === '--vendor') opts.vendorUrl = value();
    else if (arg === '--force') opts.force = true;
    else if (arg === '--no-demo') opts.noDemo = true;
    else if (arg === '--claim') mode = 'claim';
    else if (arg === '--mainnet') mode = 'mainnet';
    else if (arg === '--approve' || arg === '--reject') {
      mode = 'approve';
      verdict = arg === '--approve' ? 'approve' : 'reject';
      decisionId = value();
    } else if (arg === '--yes') yes = true;
    else {
      console.error(`unknown option ${arg}\n\n${HELP}`);
      return 2;
    }
    if (missing) {
      console.error(`${arg} needs a value\n\n${HELP}`);
      return 2;
    }
  }
  try {
    if (mode === 'claim') await runClaim();
    else if (mode === 'mainnet') await runMainnet();
    else if (mode === 'approve') await runApprove({ decisionId, verdict, yes });
    else await runInit(opts);
    return 0;
  } catch (err) {
    console.error(`\n[rein] ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
