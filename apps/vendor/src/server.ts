/**
 * Rein's reference vendor: a real x402 seller, gated by @reinconsole/gate
 * (Sprint 5.3).
 *
 * This is the other half of the picture the console renders. The hosted
 * engine governs what an agent is ALLOWED to spend; this process is something
 * for it to spend ON — a small paid API on real rails, so that "a settled
 * payment appears on the dashboard" is an end-to-end fact rather than a demo
 * scenario replaying against a mock chain.
 *
 * TWO GATES IN ONE PROCESS, and they are separate objects on purpose.
 * `GateOptions.rails` is gate-level, not route-level: one gate cannot settle
 * some routes through the open testnet facilitator and others through a
 * mainnet one (PayAI, or CDP when credentials are set).
 * Beyond the plumbing, the two lanes disagree about the things that only
 * surface when money is real — the USDC contract address, the facilitator's
 * credentials, and the EIP-712 domain name, which is `USDC` on Base Sepolia
 * and `USD Coin` on Base mainnet (S58: a payer that signs the wrong one
 * produces a well-formed signature the token contract rejects at settlement,
 * invisible on testnet and first visible with real money). Two gates make
 * that a structural fact rather than a branch someone can get wrong.
 *
 * The mainnet lane is NOT constructed unless `REIN_VENDOR_MAINNET=1`. Until
 * Sprint 8 this process cannot take a real payment even if someone sends one:
 * `/v1/*` has no gate in front of it and 404s.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  BASE_ETH_USD_FEED,
  PAYAI_PRICING_URL,
  createGate,
  facilitatorClientRails,
  gateMiddleware,
  settlementCostOracle,
  type Gate,
  type GateOutcome,
  type GateStorePort,
} from '@reinconsole/gate';
import { ReputationGraph } from '@reinconsole/graph';
import { createProfileFacilitator } from '@reinconsole/x402-rails';
import { routesFor, type VendorConfig, type VendorLane } from './config.js';

export interface VendorLaneRuntime {
  lane: VendorLane;
  gate: Gate;
  paywall: ReturnType<typeof gateMiddleware>;
}

export interface VendorServerOptions {
  config: VendorConfig;
  /** Durable gate storage, one store per lane. In-memory when omitted. */
  storeFor?: (lane: VendorLane) => GateStorePort | undefined;
  /** Injected in tests so no request leaves the process. */
  railsFor?: (lane: VendorLane) => ReturnType<typeof facilitatorClientRails>;
  /** Injected in tests: the surge cost oracle for a lane that sets `surge`. */
  costFor?: (lane: VendorLane) => () => Promise<string>;
  now?: () => Date;
}

export interface VendorServer {
  server: Server;
  lanes: VendorLaneRuntime[];
  graph: ReputationGraph;
  listen(): Promise<number>;
  close(): Promise<void>;
}

/** The public `/stats` body — what this vendor has earned, per lane. */
interface LaneStats {
  network: string;
  prefix: string;
  payTo: string;
  quoted: number;
  settled: number;
  refused: number;
  revenue: Record<string, string>;
  routes: Record<string, { settled: number; revenue: string }>;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(payload);
}

function buildLane(lane: VendorLane, options: VendorServerOptions): VendorLaneRuntime {
  const { config } = options;
  const rails =
    options.railsFor?.(lane) ??
    facilitatorClientRails(
      createProfileFacilitator(lane.profile, {
        // An override is judged by its host, so PayAI gets no CDP headers.
        ...(lane.facilitatorUrl ? { url: lane.facilitatorUrl } : {}),
        ...(config.cdp
          ? { cdp: { apiKeyId: config.cdp.apiKeyId, apiKeySecret: config.cdp.apiKeySecret } }
          : {}),
      }),
    );

  const store = options.storeFor?.(lane);
  const cost =
    lane.surge &&
    (options.costFor?.(lane) ??
      settlementCostOracle({
        rpcUrl: lane.surge.rpcUrl,
        ethUsdFeed: BASE_ETH_USD_FEED,
        pricing: { url: PAYAI_PRICING_URL, network: lane.profile.caip2 },
      }));
  const gate = createGate({
    routes: routesFor(lane),
    rails,
    payTo: lane.payTo,
    network: lane.profile.network,
    asset: lane.profile.usdc,
    decimals: lane.profile.decimals,
    // The domain the payer must sign against, taken from the PROFILE rather
    // than written out here. This is the constant S58 found hardcoded, and
    // the only safe place for it is the one table that knows both networks.
    extra: { name: lane.profile.eip712.name, version: lane.profile.eip712.version },
    advertiseV2: lane.advertiseV2,
    velocity: config.velocity,
    ...(cost ? { surge: { cost } } : {}),
    ...(store ? { store } : {}),
    ...(options.now ? { now: options.now } : {}),
  });

  return {
    lane,
    gate,
    paywall: gateMiddleware(gate, {
      ...(config.origin ? { origin: config.origin } : {}),
      onOutcome: (outcome: GateOutcome) => {
        if (outcome.kind === 'refused') {
          console.warn(`[vendor] ${lane.profile.name} refused: [${outcome.code}] ${outcome.reason}`);
        }
      },
    }),
  };
}

/**
 * Which lane, if any, owns this request.
 *
 * Longest prefix first, so the mainnet lane's empty prefix (which matches
 * everything) can never swallow `/testnet/...`. Getting this backwards would
 * quote a testnet path at mainnet prices against the mainnet treasury — the
 * single worst routing bug this process could have, so the ordering is
 * explicit here rather than implied by the order lanes happen to be built in.
 */
export function laneFor(lanes: VendorLaneRuntime[], pathname: string): VendorLaneRuntime | undefined {
  return [...lanes]
    .sort((a, b) => b.lane.prefix.length - a.lane.prefix.length)
    .find((l) => l.lane.prefix === '' || pathname.startsWith(`${l.lane.prefix}/`));
}

export function createVendorServer(options: VendorServerOptions): VendorServer {
  const lanes = options.config.lanes.map((lane) => buildLane(lane, options));

  // The graph watches this vendor's own gates, which is the only evidence it
  // legitimately has: who paid it, how often, and what was refused. The
  // reputation graph itself stays FROZEN at Phase 3's design — nothing here
  // extends it, and the route below sells a read of it, not a new model.
  const graph = new ReputationGraph(options.now ? { now: options.now } : {});
  for (const l of lanes) graph.observe(l.gate);

  function stats(): { vendor: string; lanes: LaneStats[] } {
    return {
      vendor: 'rein-reference-vendor',
      lanes: lanes.map(({ lane, gate }): LaneStats => {
        const s = gate.stats();
        return {
          network: lane.profile.network,
          prefix: lane.prefix,
          payTo: lane.payTo,
          quoted: s.quoted,
          settled: s.settled,
          refused: s.refused,
          revenue: s.revenue,
          routes: s.routes,
        };
      }),
    };
  }

  /** What a paid request gets, once the gate has settled it. */
  function serve(req: IncomingMessage, res: ServerResponse, runtime: VendorLaneRuntime): void {
    const url = new URL(req.url ?? '/', 'http://vendor.invalid');
    const path = url.pathname.slice(runtime.lane.prefix.length);

    if (path === '/v1/ping') {
      json(res, 200, {
        pong: true,
        network: runtime.lane.profile.network,
        at: new Date().toISOString(),
      });
      return;
    }

    const scoreMatch = /^\/v1\/scores\/vendor\/(.+)$/.exec(path);
    if (scoreMatch) {
      const host = decodeURIComponent(scoreMatch[1] as string).toLowerCase();
      const score = graph.score({ kind: 'vendor', id: host });
      // A paid lookup answers even when the answer is "nothing known". The
      // buyer paid for an authoritative reading of this vendor's evidence,
      // and `known: false` IS that reading — a 404 would take the money and
      // imply the route was broken. What must never happen is a fabricated
      // score for a host nobody has transacted with, which is the failure a
      // reputation service is one shortcut away from.
      json(res, 200, {
        host,
        known: score !== undefined,
        score: score ?? null,
        source: 'rein-reference-vendor gate evidence',
      });
      return;
    }

    json(res, 404, { error: 'not_found' });
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://vendor.invalid');

    // Free and public, deliberately: `/stats` is how the console's gate panel
    // learns what this vendor earned, and putting a paywall on the number
    // would mean the dashboard had to pay to render itself.
    if (url.pathname === '/stats') return json(res, 200, stats());
    if (url.pathname === '/health') {
      return json(res, 200, {
        status: 'ok',
        lanes: lanes.map((l) => ({ network: l.lane.profile.network, prefix: l.lane.prefix })),
      });
    }

    const runtime = laneFor(lanes, url.pathname);
    if (!runtime) return json(res, 404, { error: 'not_found' });

    runtime.paywall(req, res, () => serve(req, res, runtime));
  });

  return {
    server,
    lanes,
    graph,
    listen: () =>
      new Promise<number>((resolve) => {
        server.listen(options.config.port, options.config.host, () => {
          const address = server.address();
          resolve(typeof address === 'object' && address ? address.port : options.config.port);
        });
      }),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
