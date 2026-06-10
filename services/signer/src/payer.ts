import type { FetchLike, Payer } from '@rein/sdk';
import { SignerError, type RefusalCode } from './errors.js';
import type { SessionSigner } from './signer.js';

/**
 * In-process `Payer` for the SDK guard: the agent side holds only the session
 * token — the guard's allow decision travels through the seam as the voucher.
 */
export function sessionPayerFor(signer: SessionSigner, sessionToken: string): Payer {
  return async (requirement, intent, decision) =>
    (await signer.sign({ sessionToken, requirement, intent, decision })).paymentHeader;
}

export interface RemoteSessionPayerOptions {
  /** Signer service base URL, e.g. "http://localhost:8788". */
  signerUrl: string;
  sessionToken: string;
  fetch?: FetchLike;
}

/** HTTP `Payer` for a signer running as its own service. Refusals surface as SignerError. */
export function createRemoteSessionPayer(options: RemoteSessionPayerOptions): Payer {
  const f = options.fetch ?? globalThis.fetch;
  const base = options.signerUrl.replace(/\/$/, '');
  return async (requirement, intent, decision) => {
    const res = await f(`${base}/v1/sign`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionToken: options.sessionToken, requirement, intent, decision }),
    });
    const body: unknown = await res.json().catch(() => undefined);
    const record =
      typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
    if (!res.ok) {
      if (res.status === 403 && typeof record['code'] === 'string') {
        throw new SignerError(
          record['code'] as RefusalCode,
          typeof record['reason'] === 'string' ? record['reason'] : 'signing refused',
        );
      }
      throw new Error(`signer responded ${res.status}`);
    }
    if (typeof record['paymentHeader'] !== 'string') {
      throw new Error('signer response missing paymentHeader');
    }
    return record['paymentHeader'];
  };
}
