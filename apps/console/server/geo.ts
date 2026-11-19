/**
 * The console's half of the geo-block (S98, docs/legal/decisions.md): sign-in
 * and the claim happen HERE, in the browser, so the engine never sees the
 * person's address for them -- only the console's. Every request from a
 * refused territory gets the engine's own `451 restricted_territory`.
 *
 * Two kinds of refusal (2026-11-18). A SANCTIONED territory gets the bare
 * line. A territory the hosted service is merely not offered in (the EEA, the
 * UK) gets a page that says so and points at self-hosting -- the software is
 * open there, the hosted service is not.
 *
 * The client is found by walking `X-Forwarded-For` inward through private
 * peers (`clientAddress`), the same rule as the engine's `REIN_TRUST_PROXY=1`:
 * on Railway the edge reaches us from the internal network and appends the
 * address it saw, so nothing a client writes can move the answer, and a
 * client that connects directly is judged by its socket.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  GEOBLOCK_STATUS,
  SELF_HOST_URL,
  clientAddress,
  geoBlockBody,
  sanctionedTerritory,
  type GeoBlock,
} from '@reinconsole/policy-engine';
import { OPERATOR_PATH, type OperatorPass } from './operator';

/**
 * Self-contained on purpose: every other request from the same address is
 * refused too, so the page can load no stylesheet, font or script of ours.
 */
const NOT_OFFERED_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Rein -- not available in your region</title>
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0b0d10; color: #e8eaed;
    font: 16px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 34rem; padding: 2rem 1.25rem; }
  h1 { font-size: 1.4rem; line-height: 1.3; margin: 0 0 1rem; }
  p { margin: 0 0 1rem; color: #b6bcc6; }
  a { color: #7ee0b8; }
  code { font: 0.9em ui-monospace, Consolas, monospace; color: #e8eaed; }
</style>
</head>
<body>
<main>
  <h1>The hosted Rein service is not available in your region yet.</h1>
  <p>Rein is open source (MIT). You can run the same engine and console yourself, on your own machine or server,
    with no account and nothing sent to us.</p>
  <p><a href="${SELF_HOST_URL}">Self-host Rein</a></p>
  <p>This applies to the hosted service at <code>reinconsole.com</code> in the European Economic Area and the
    United Kingdom. HTTP 451.</p>
</main>
</body>
</html>
`;

/** True when the request was refused and answered. */
export function createGeoGate(geoBlock: GeoBlock | undefined, operatorPass?: OperatorPass) {
  return function refuse(req: IncomingMessage, res: ServerResponse): boolean {
    if (!geoBlock) return false;
    const client = clientAddress(req.socket.remoteAddress, req.headers['x-forwarded-for']);
    const territory = geoBlock.territoryOf(client);
    if (territory === undefined) return false;
    // The operator's own team (operator.ts): a not-offered territory only,
    // never a sanctioned one.
    if (operatorPass && !sanctionedTerritory(territory)) {
      if (operatorPass.holds(req)) return false;
      if ((req.url ?? '').split('?')[0] === OPERATOR_PATH) {
        void operatorPass.handle(req, res).catch(() => {
          if (!res.headersSent) res.writeHead(500);
          res.end();
        });
        return true;
      }
    }
    const body = geoBlockBody(territory);
    const wantsJson = (req.url ?? '').startsWith('/api/');
    const page = !wantsJson && !sanctionedTerritory(territory);
    res.writeHead(GEOBLOCK_STATUS, {
      'Content-Type': wantsJson ? 'application/json' : page ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(wantsJson ? JSON.stringify(body) : page ? NOT_OFFERED_PAGE : `${body.message}\n`);
    return true;
  };
}
