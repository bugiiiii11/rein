/**
 * The console's half of the geo-block (S98, docs/legal/decisions.md): sign-in
 * and the claim happen HERE, in the browser, so the engine never sees the
 * person's address for them -- only the console's. Every request from a
 * refused territory gets the engine's own `451 restricted_territory`.
 *
 * The client is found by walking `X-Forwarded-For` inward through private
 * peers (`clientAddress`), the same rule as the engine's `REIN_TRUST_PROXY=1`:
 * on Railway the edge reaches us from the internal network and appends the
 * address it saw, so nothing a client writes can move the answer, and a
 * client that connects directly is judged by its socket.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { GEOBLOCK_BODY, GEOBLOCK_STATUS, clientAddress, type GeoBlock } from '@reinconsole/policy-engine';

/** True when the request was refused and answered. */
export function createGeoGate(geoBlock: GeoBlock | undefined) {
  return function refuse(req: IncomingMessage, res: ServerResponse): boolean {
    if (!geoBlock) return false;
    const client = clientAddress(req.socket.remoteAddress, req.headers['x-forwarded-for']);
    if (geoBlock.territoryOf(client) === undefined) return false;
    const wantsJson = (req.url ?? '').startsWith('/api/');
    res.writeHead(GEOBLOCK_STATUS, {
      'Content-Type': wantsJson ? 'application/json' : 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(wantsJson ? JSON.stringify(GEOBLOCK_BODY) : `${GEOBLOCK_BODY.message}\n`);
    return true;
  };
}
