import { globMatch } from '@rein/core';
import { PaymentRequirement, decimalToAtomic } from '@rein/sdk';

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
