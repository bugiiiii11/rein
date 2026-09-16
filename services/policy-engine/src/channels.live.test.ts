import { describe, expect, it } from 'vitest';
import { TelegramChannel } from './channels.js';

/**
 * LIVE tests against the real Telegram Bot API. Gated on RUN_LIVE (network).
 *
 *   $env:NODE_EXTRA_CA_CERTS = "$HOME\\.rein-dev-ca.pem"; $env:RUN_LIVE = "1"
 *   $env:REIN_TELEGRAM_BOT_TOKEN = "<token>"; $env:REIN_TELEGRAM_CHAT_ID = "<chat id>"
 *   pnpm --filter @reinconsole/policy-engine test -- channels.live
 *
 * The first test needs only the network: the real API refuses a made-up
 * token, and the channel must surface that instead of counting the message
 * delivered. The second posts one real message to your chat and needs both
 * variables -- it is the only proof that the token, the chat id and the bot's
 * membership in that chat line up, which no mock can give.
 */
const live = Boolean(process.env['RUN_LIVE']);
const botToken = process.env['REIN_TELEGRAM_BOT_TOKEN']?.trim();
const chatId = process.env['REIN_TELEGRAM_CHAT_ID']?.trim();

describe.skipIf(!live)('live: Telegram Bot API', () => {
  it('surfaces a refused token instead of reporting delivery', async () => {
    const channel = new TelegramChannel({ botToken: '000000000:rein-not-a-real-token', chatId: 1 });
    await expect(channel.send('rein live check')).rejects.toThrow(
      /telegram sendMessage failed: 40[14]/,
    );
  });

  it.skipIf(!botToken || !chatId)('delivers to the configured chat', async () => {
    const channel = new TelegramChannel({ botToken: botToken!, chatId: chatId! });
    await expect(
      channel.send(`Rein live check ${new Date().toISOString()} -- the Telegram channel is wired.`),
    ).resolves.toBeUndefined();
  });
});
