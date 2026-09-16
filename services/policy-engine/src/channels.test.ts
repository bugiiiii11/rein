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

describe('TelegramChannel', () => {
  const token = '7439012345:AAF-e2e-test-token-not-real';
  const url = (input: unknown) => (input instanceof Request ? input.url : String(input));

  it('posts to the Bot API with the token in the path and the chat id in the body', async () => {
    const calls: { url: string; body: unknown }[] = [];
    const channel = new TelegramChannel({
      botToken: token,
      chatId: 42,
      fetch: async (input, init) => {
        calls.push({ url: url(input), body: JSON.parse(String(init?.body)) });
        return new Response('{"ok":true}', { status: 200 });
      },
    });
    await channel.send('hello');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`https://api.telegram.org/bot${token}/sendMessage`);
    expect(calls[0]!.body).toMatchObject({ chat_id: '42', text: 'hello' });
  });

  it('never lets the token out through a transport failure', async () => {
    // The request URL IS the token, and undici quotes the URL in the errors
    // it throws. A channel that rethrew the transport error as-is would hand
    // the bot token to every log line and error hook downstream of it.
    const channel = new TelegramChannel({
      botToken: token,
      chatId: 42,
      fetch: async (input) => {
        throw new TypeError(`fetch failed for ${url(input)}`, {
          cause: Object.assign(new Error(`connect ECONNREFUSED ${url(input)}`), {
            code: 'ECONNREFUSED',
          }),
        });
      },
    });
    const failure = await channel.send('hello').then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(failure).toBeInstanceOf(Error);
    const { message, cause } = failure as Error;
    expect(message).not.toContain(token);
    expect(message).toContain('[redacted]');
    // The diagnosis survives the redaction: what failed, and with which code.
    expect(message).toMatch(/telegram sendMessage failed/);
    expect(message).toContain('ECONNREFUSED');
    // No cause chain rides along -- that is where the original URL lives.
    expect(cause).toBeUndefined();
    // And the channel object itself carries no token a dump could print.
    expect(JSON.stringify(channel)).not.toContain(token);
  });

  it('reports a refused send by status, never by URL', async () => {
    const channel = new TelegramChannel({
      botToken: token,
      chatId: 42,
      fetch: async () => new Response('forbidden', { status: 403 }),
    });
    await expect(channel.send('hello')).rejects.toThrow(/failed: 403$/);
  });
});
