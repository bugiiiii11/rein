import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Gate, GateOutcome } from './gate.js';

export interface GateMiddlewareOptions {
  /**
   * Origin used to absolutize req.url for quotes, e.g. "https://api.vendor.com".
   * Defaults to http://<Host header> — set this when serving behind TLS/proxies
   * so quoted resources match what agents actually requested.
   */
  origin?: string;
  /** Called with every outcome — the vendor's observability hook. */
  onOutcome?: (outcome: GateOutcome, req: IncomingMessage) => void;
}

/**
 * Drop the gate in front of any Node HTTP handler. Express-compatible
 * `(req, res, next)` signature; with a raw `node:http` server, pass your
 * content handler as `next`:
 *
 *   const paywall = gateMiddleware(gate);
 *   http.createServer((req, res) => paywall(req, res, () => serve(req, res)));
 *
 * Free and paid requests reach `next()` (paid ones with X-PAYMENT-RESPONSE
 * already set on the response); quotes and refusals are answered here and
 * never reach the vendor's handler.
 */
export function gateMiddleware(gate: Gate, options: GateMiddlewareOptions = {}) {
  return (req: IncomingMessage, res: ServerResponse, next: () => void): void => {
    void (async () => {
      const origin = options.origin ?? `http://${req.headers.host ?? 'localhost'}`;
      const url = new URL(req.url ?? '/', origin).toString();
      const raw = req.headers['x-payment'];
      const payment = (Array.isArray(raw) ? raw[0] : raw) ?? null;

      const outcome = await gate.handle({ method: req.method ?? 'GET', url, payment });
      options.onOutcome?.(outcome, req);

      if (outcome.kind === 'open') return next();
      if (outcome.kind === 'paid') {
        res.setHeader('X-PAYMENT-RESPONSE', outcome.settlementHeader);
        return next();
      }
      res.writeHead(outcome.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(outcome.body));
    })().catch((err: unknown) => {
      // A rails outage must not crash the vendor's server: answer 500, move on.
      const message = err instanceof Error ? err.message : String(err);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'internal_error', message }));
    });
  };
}
