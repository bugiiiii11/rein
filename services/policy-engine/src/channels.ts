import type { ApprovalChallenges, ApprovalRequest } from '@reinconsole/core';
import type { ApprovalChannel } from './approvals.js';

/**
 * Approval delivery channels.
 *
 * Every channel here is one-way on purpose. A channel announces that a payment
 * is waiting and hands over the exact bytes to sign; nothing it receives back
 * is read, and no channel exposes a button, callback, or command that resolves
 * a request. The engine only ever accepts a signature made by a registered
 * approver key. This is not an oversight to be fixed later with a nicer UX —
 * it is what keeps a compromised bot token from being a compromised treasury.
 */

/** The human-readable half of a challenge: what the approver is judging. */
export function formatChallenge(
  request: ApprovalRequest,
  challenges: ApprovalChallenges,
): string {
  return [
    'Rein: a payment needs your approval',
    '',
    `Agent     ${request.agentId}`,
    `Pay       ${request.amount} ${request.asset} on ${request.chain} -> ${request.vendorHost}`,
    `Resource  ${request.resource}`,
    `Why       ${request.reason}`,
    `Decision  ${request.decisionId}`,
    `Expires   ${request.expiresAt.toISOString()} (denies if unanswered)`,
    '',
    'Sign exactly ONE of these strings with your approver key and submit the',
    'signature to the engine. Replying here approves nothing.',
    '',
    'APPROVE:',
    challenges.approve,
    '',
    'REJECT:',
    challenges.reject,
  ].join('\n');
}

export interface LoggingChannelOptions {
  name?: string;
  write?: (message: string) => void;
}

/**
 * Prints the challenge. The default channel for local runs and the standalone
 * server: without it an escalation is invisible until it expires.
 */
export class LoggingApprovalChannel implements ApprovalChannel {
  readonly name: string;
  private readonly write: (message: string) => void;

  constructor(options: LoggingChannelOptions = {}) {
    this.name = options.name ?? 'log';
    this.write = options.write ?? ((message) => console.log(message));
  }

  deliver(request: ApprovalRequest, challenges: ApprovalChallenges): void {
    this.write(`[rein] ${formatChallenge(request, challenges)}`);
  }
}

export interface TelegramChannelOptions {
  botToken: string;
  chatId: string | number;
  /** Override the transport (tests, proxies). Defaults to global fetch. */
  fetch?: typeof globalThis.fetch;
  /** Base URL of the Bot API, for self-hosted bot servers. */
  apiBase?: string;
  name?: string;
}

/**
 * Telegram delivery. Notification only: the message carries no `reply_markup`,
 * so there is nothing to tap, and the bot never listens for a reply. Text is
 * sent WITHOUT a parse mode — vendor hosts and policy reasons are
 * attacker-influenced strings, and none of them should be able to inject
 * markup into a message a human reads before authorizing money.
 */
export class TelegramApprovalChannel implements ApprovalChannel {
  readonly name: string;
  private readonly url: string;
  private readonly chatId: string;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(options: TelegramChannelOptions) {
    if (!options.botToken) throw new TypeError('TelegramApprovalChannel needs a botToken');
    this.name = options.name ?? 'telegram';
    const base = (options.apiBase ?? 'https://api.telegram.org').replace(/\/+$/, '');
    this.url = `${base}/bot${options.botToken}/sendMessage`;
    this.chatId = String(options.chatId);
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  async deliver(request: ApprovalRequest, challenges: ApprovalChallenges): Promise<void> {
    const res = await this.fetchImpl(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: this.chatId,
        text: formatChallenge(request, challenges),
        disable_web_page_preview: true,
      }),
    });
    if (!res.ok) {
      // Surfaced to the service's onDeliveryError; the request stays parked.
      throw new Error(`telegram sendMessage failed: ${res.status}`);
    }
  }
}
