import { globMatch } from '@reinconsole/core';
import { PaymentRequirement, decimalToAtomic } from '@reinconsole/sdk';

/**
 * One priced route. Anything a route doesn't override falls back to the
 * gate-level payment defaults, so most vendors only write `path` + `price`.
 */
export interface GateRoute {
  /** Glob over the request path, e.g. "/api/reports/*". First match wins. */
  path: string;
  /** HTTP method (case-insensitive); omit to price every method. */
  method?: string;
  /** Human-unit decimal price, e.g. "0.05". */
  price: string;
  description?: string;
  mimeType?: string;
  payTo?: string;
  network?: string;
  asset?: string;
  /** Atomic decimals of the asset (default 6, all Rein stablecoins). */
  decimals?: number;
  maxTimeoutSeconds?: number;
  /** EIP-712 domain hints etc., merged over the gate-level extra. */
  extra?: Record<string, unknown>;
  /**
   * Machine-readable discovery metadata for this route (Sprint 5.4).
   *
   * Present, it rides the v2 402 as `extensions.bazaar` -- what the route
   * takes and what it returns, so an agent that has never seen this vendor
   * can decide whether to buy WITHOUT a human reading the docs. That is the
   * whole premise of a marketplace of paid APIs: the 402 is the listing.
   *
   * It advertises only. Nothing here is validated against the handler, and
   * the gate enforces none of it -- a schema that claimed one shape while the
   * route served another would be a lie the gate had signed off on, so the
   * gate deliberately signs off on nothing. Carried on the v2 wire ONLY
   * (`advertiseV2`): the v1 body has no extension slot, and inventing one
   * would break every published v1 client's parser.
   */
  discovery?: {
    /** JSON Schema (or any agreed descriptor) for the request. */
    input?: unknown;
    /** The same for the response body a paid call returns. */
    output?: unknown;
  };
}

/** Gate-level payment defaults every route inherits. */
export interface PaymentDefaults {
  payTo: string;
  network: string;
  asset: string;
  decimals?: number;
  maxTimeoutSeconds?: number;
  extra?: Record<string, unknown>;
}

/** First route whose method and path glob accept the request, or undefined. */
export function matchRoute(
  routes: readonly GateRoute[],
  method: string,
  pathname: string,
): GateRoute | undefined {
  return routes.find(
    (route) =>
      (route.method === undefined || route.method.toUpperCase() === method.toUpperCase()) &&
      globMatch(route.path, pathname),
  );
}

export function routeDecimals(route: GateRoute, defaults: PaymentDefaults): number {
  return route.decimals ?? defaults.decimals ?? 6;
}

/**
 * Build the v1 payment requirement this route quotes for a concrete resource
 * URL. Fully populated (description/mimeType/maxTimeoutSeconds, absolute
 * resource) because hosted facilitators validate requirements strictly.
 */
export function requirementFor(
  route: GateRoute,
  defaults: PaymentDefaults,
  resourceUrl: string,
): PaymentRequirement {
  const decimals = routeDecimals(route, defaults);
  const extra: Record<string, unknown> = {
    ...(defaults.extra ?? {}),
    ...(route.extra ?? {}),
    // Non-standard decimals must travel with the quote or payers misprice.
    ...(decimals !== 6 ? { decimals } : {}),
  };
  return PaymentRequirement.parse({
    scheme: 'exact',
    network: route.network ?? defaults.network,
    maxAmountRequired: decimalToAtomic(route.price, decimals),
    resource: resourceUrl,
    description: route.description ?? '',
    mimeType: route.mimeType ?? 'application/json',
    payTo: route.payTo ?? defaults.payTo,
    maxTimeoutSeconds: route.maxTimeoutSeconds ?? defaults.maxTimeoutSeconds ?? 300,
    asset: route.asset ?? defaults.asset,
    extra: Object.keys(extra).length > 0 ? extra : undefined,
  });
}
