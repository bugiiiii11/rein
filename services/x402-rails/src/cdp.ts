import { FacilitatorClient, type FacilitatorClientOptions } from './facilitator.js';
import { RailsError } from './errors.js';
import type { NetworkProfile } from './profiles.js';

/**
 * Coinbase CDP credentials — the mainnet facilitator's price of entry.
 *
 * `apiKeyId` / `apiKeySecret` are what the CDP portal calls a Secret API Key.
 * They are NOT a wallet: they authenticate the caller to the facilitator,
 * which then submits someone else's signed authorization. Rein never hands
 * CDP a spending key, and nothing here can move money on its own.
 */
export interface CdpCredentials {
  apiKeyId: string;
  apiKeySecret: string;
}

/**
 * Mint the CDP bearer for one request.
 *
 * `@coinbase/cdp-sdk` is an OPTIONAL peer dependency, imported dynamically so
 * that installing @reinconsole/x402-rails does not drag a mainnet SDK into
 * every testnet install -- and so this whole module stays inert until someone
 * actually configures mainnet. A missing package surfaces as a ConfigError-
 * shaped message naming the install, not a module-resolution stack.
 */
export async function cdpAuthHeaders(
  credentials: CdpCredentials,
  request: { method: string; path: string },
  host = 'api.cdp.coinbase.com',
): Promise<Record<string, string>> {
  const { generateJwt } = await loadCdpAuth();
  const token = await generateJwt({
    apiKeyId: credentials.apiKeyId,
    apiKeySecret: credentials.apiKeySecret,
    requestMethod: request.method,
    requestHost: host,
    requestPath: request.path,
  });
  return { authorization: `Bearer ${token}` };
}

interface CdpAuthModule {
  generateJwt: (options: {
    apiKeyId: string;
    apiKeySecret: string;
    requestMethod: string;
    requestHost: string;
    requestPath: string;
  }) => Promise<string>;
}

/**
 * Built rather than written literally so the compiler cannot try to resolve
 * it. An optional peer dependency is by definition absent from most installs,
 * and a static `import('@coinbase/cdp-sdk/auth')` fails TYPECHECK for everyone
 * who has not installed a mainnet SDK they may never use. The cost is that
 * the shape is unchecked, which `CdpAuthModule` above states explicitly and
 * `cdp.test.ts` pins against a stub.
 */
const CDP_AUTH_MODULE = ['@coinbase', 'cdp-sdk', 'auth'].join('/');

async function loadCdpAuth(): Promise<CdpAuthModule> {
  try {
    return (await import(CDP_AUTH_MODULE)) as unknown as CdpAuthModule;
  } catch (cause) {
    throw new RailsError(
      'unsupported_network',
      'the mainnet facilitator needs the optional peer dependency @coinbase/cdp-sdk — ' +
        `install it (\`pnpm add @coinbase/cdp-sdk\`) or point at a facilitator that takes no credentials (${String(cause)})`,
    );
  }
}

export interface ProfileFacilitatorOptions {
  /** Override the profile's facilitator URL (a self-hosted one, or a stub). */
  url?: string;
  /** CDP credentials. Required when the resolved facilitator authenticates with `cdp`. */
  cdp?: CdpCredentials;
  /** Transport override (tests inject a stub here). */
  fetch?: FacilitatorClientOptions['fetch'];
}

/**
 * The facilitator a profile names, with its credentials already wired.
 *
 * Throws when a CDP-authenticated URL is configured without credentials
 * rather than letting the first real payment discover it. An unauthenticated
 * call to the CDP facilitator comes back 401, which is indistinguishable at a
 * glance from a bad payment -- and it would surface at settlement time, on
 * the one network where the money is real.
 *
 * `url` is honoured because the auth decision follows the URL, not the
 * profile name: pointing mainnet at a local stub must not demand CDP keys,
 * and pointing testnet at the CDP endpoint must demand them.
 */
export function createProfileFacilitator(
  profile: NetworkProfile,
  options: ProfileFacilitatorOptions = {},
): FacilitatorClient {
  const url = options.url ?? profile.facilitatorUrl;
  const needsCdp = usesCdp(url, profile, options.url !== undefined);

  if (needsCdp && !options.cdp) {
    throw new RailsError(
      'unsupported_network',
      `facilitator ${url} requires Coinbase CDP credentials — set REIN_CDP_API_KEY_ID and REIN_CDP_API_KEY_SECRET`,
    );
  }

  const host = hostOf(url);
  const credentials = options.cdp;
  return new FacilitatorClient({
    url,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(needsCdp && credentials
      ? { authHeaders: (request) => cdpAuthHeaders(credentials, request, host) }
      : {}),
  });
}

/**
 * Does this URL need CDP credentials? The profile decides when the URL is the
 * profile's own; an explicit override is judged by its host, so a stub is
 * open and a hand-typed CDP endpoint is not.
 */
function usesCdp(url: string, profile: NetworkProfile, overridden: boolean): boolean {
  if (!overridden) return profile.facilitatorAuth === 'cdp';
  return hostOf(url).endsWith('cdp.coinbase.com');
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}
