import { describe, expect, it } from 'vitest';
import { LoggingChannel, TelegramChannel } from './channels.js';
import { channelsFromEnv } from './server.js';

describe('channelsFromEnv', () => {
  it('always logs, and adds telegram only when the token and the chat id are both set', () => {
    expect(channelsFromEnv({}).map((c) => c.name)).toEqual(['log']);
    const both = channelsFromEnv({ REIN_TELEGRAM_BOT_TOKEN: ' t ', REIN_TELEGRAM_CHAT_ID: ' 42 ' });
    expect(both.map((c) => c.name)).toEqual(['log', 'telegram']);
    expect(both[0]).toBeInstanceOf(LoggingChannel);
    expect(both[1]).toBeInstanceOf(TelegramChannel);
  });

  it('refuses half a Telegram configuration rather than silently paging nobody', () => {
    expect(() => channelsFromEnv({ REIN_TELEGRAM_BOT_TOKEN: 't' })).toThrow(
      /REIN_TELEGRAM_CHAT_ID is missing/,
    );
    expect(() => channelsFromEnv({ REIN_TELEGRAM_CHAT_ID: '42' })).toThrow(
      /REIN_TELEGRAM_BOT_TOKEN is missing/,
    );
    // Whitespace is not a value.
    expect(() => channelsFromEnv({ REIN_TELEGRAM_BOT_TOKEN: 't', REIN_TELEGRAM_CHAT_ID: '  ' })).toThrow();
  });
});
