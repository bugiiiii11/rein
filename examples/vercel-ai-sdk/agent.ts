// Run: ANTHROPIC_API_KEY=... npx tsx agent.ts
import { generateText, isStepCount } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import { fetchPaid, guard } from './rein-tool.js';

const { text } = await generateText({
  model: anthropic('claude-sonnet-5'),
  tools: { fetchPaid },
  stopWhen: isStepCount(5),
  prompt:
    'Call https://vendor.reinconsole.com/testnet/v1/ping, then ' +
    'https://vendor.reinconsole.com/testnet/v1/scores/vendor/api.example.com. ' +
    'Report what each one returned and whether it was paid or blocked.',
});

console.log(text);

// Every paywall the agent met, allowed or not, as a receipt.
for (const r of guard.receipts()) {
  console.log(r.outcome, r.amount, r.asset, r.url, r.settlement?.txHash ?? r.reason ?? '');
}
