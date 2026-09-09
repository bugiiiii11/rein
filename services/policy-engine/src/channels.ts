import type { ApprovalChallenges, ApprovalRequest } from '@reinconsole/core';
import type { ApprovalChannel } from './approvals.js';
import type { AlertChannel, LivenessAlert } from './liveness.js';

/**
 * Delivery channels: how the engine reaches a human.
 *
 * Every channel here is one-way on purpose. A channel announces that a payment
 * is waiting and hands over the exact bytes to sign; nothing it receives back
 * is read, and no channel exposes a button, callback, or command that resolves
 * a request. The engine only ever accepts a signature made by a registered
 * approver key. This is not an oversight to be fixed later with a nicer UX —
 * it is what keeps a compromised bot token from being a compromised treasury.
 *
 * B2 added the second kind of news: a dead-man alarm. It shares the transport
 * and nothing else. An approval hands over bytes to sign and waits for them;
 * an alarm asks for nothing at all, because no verdict would end it — only the
 * agent being seen again does. So each class below implements both
 * {@link ApprovalChannel} and {@link AlertChannel} over one `send`, and the
 * one-way rule holds for both, for the same reason.
 */

/**
 * The transport under both kinds of news: put text in front of a human.
 * Formatting stays with the caller, so a third kind of notice needs a
 * formatter rather than a new class per destination.
 */
export interface NotifyChannel {
  readonly name: string;
  send(text: string): Promise<void> | void;
}

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

/** Coarse, human-readable silence: "45s", "12m", "3h 10m", "4d 6h". */
export function formatSilence(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${seconds}s`;
}

/**
 * The human-readable alarm (B2).
 *
 * It deliberately does not tell the reader how to silence it, because there is
 * no such action — an acknowledge button would be the click-to-approve mistake
 * in a new costume, and it would let whoever holds the bot token quiet the one
 * alarm that matters. What it does carry is the operator's own note: "agt_01J7…
 * is quiet" means nothing at 3am, and "sepolia price poller, every 15m" means
 * everything.
 */
export function formatAlert(alert: LivenessAlert): string {
  const seen = alert.lastSeenAt
    ? `${new Date(alert.lastSeenAt).toISOString()} (${alert.lastSource ?? 'seen'})`
    : 'never — it has not checked in once since watching began';
  const grace =
    alert.expectation.graceMs > 0
      ? ` (+${Math.round(alert.expectation.graceMs / 1000)}s grace)`
      : '';
  return [
    'Rein: an agent has gone quiet',
    '',
    `Agent     ${alert.agentId}`,
    ...(alert.expectation.note ? [`What      ${alert.expectation.note}`] : []),
    `Expected  activity at least every ${alert.expectation.interval}${grace}`,
    `Last seen ${seen}`,
    `Silent    ${formatSilence(alert.silentMs)}`,
    '',
    'Nothing has been blocked: this is about work that is NOT happening.',
    'It clears when the agent is seen again. There is nothing to acknowledge.',
  ].join('\n');
}

export interface LoggingChannelOptions {
  name?: string;
  write?: (message: string) => void;
}

/**
 * Prints the news. The default channel for local runs and the standalone
 * server: without it an escalation is invisible until it expires, and a dead
 * agent is invisible altogether.
 */
export class LoggingChannel implements ApprovalChannel, AlertChannel, NotifyChannel {
  readonly name: string;
  private readonly write: (message: string) => void;

  constructor(options: LoggingChannelOptions = {}) {
    this.name = options.name ?? 'log';
    this.write = options.write ?? ((message) => console.log(message));
  }

  send(text: string): void {
    this.write(`[rein] ${text}`);
  }

  deliver(request: ApprovalRequest, challenges: ApprovalChallenges): void {
    this.send(formatChallenge(request, challenges));
  }

  alert(alert: LivenessAlert): void {
    this.send(formatAlert(alert));
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
 * sent WITHOUT a parse mode — vendor hosts, policy reasons and operator notes
 * are attacker-influenced strings, and none of them should be able to inject
 * markup into a message a human reads before authorizing money.
 */
export class TelegramChannel implements ApprovalChannel, AlertChannel, NotifyChannel {
  readonly name: string;
  private readonly url: string;
  private readonly chatId: string;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(options: TelegramChannelOptions) {
    if (!options.botToken) throw new TypeError('TelegramChannel needs a botToken');
    this.name = options.name ?? 'telegram';
    const base = (options.apiBase ?? 'https://api.telegram.org').replace(/\/+$/, '');
    this.url = `${base}/bot${options.botToken}/sendMessage`;
    this.chatId = String(options.chatId);
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  async send(text: string): Promise<void> {
    const res = await this.fetchImpl(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: this.chatId, text, disable_web_page_preview: true }),
    });
    if (!res.ok) {
      // Surfaced to the caller's error hook: a parked escalation stays parked,
      // and an alarm that did not arrive is not counted as delivered.
      throw new Error(`telegram sendMessage failed: ${res.status}`);
    }
  }

  deliver(request: ApprovalRequest, challenges: ApprovalChallenges): Promise<void> {
    return this.send(formatChallenge(request, challenges));
  }

  alert(alert: LivenessAlert): Promise<void> {
    return this.send(formatAlert(alert));
  }
}

/**
 * The pre-B2 names, kept so an 0.1.x import keeps working. Same classes — they
 * now carry alarms as well as challenges, which is why they lost the
 * "Approval" in their names.
 */
export { LoggingChannel as LoggingApprovalChannel, TelegramChannel as TelegramApprovalChannel };
