/**
 * The reference vendor's configuration, as a pure function of the environment
 * (Sprint 5.3).
 *
 * Kept apart from `server.ts` so the decisions that matter — which networks
 * this process will take money on, whose EIP-712 domain each gate quotes,
 * whether mainnet is armed at all — are testable without opening a socket.
 * Every one of them is a thing that fails silently on testnet and expensively
 * on mainnet, which is the whole reason Sprint 5 builds this now and Sprint 8
 * only turns it on.
 */
import type { GateRoute } from '@reinconsole/gate';
import { profileFor, type NetworkProfile, type ProfileName } from '@reinconsole/x402-rails';

/** What one gate in this process is for. */
export interface VendorLane {
  /** Path prefix that selects this gate, e.g. `/testnet`. Empty for mainnet. */
  prefix: string;
  profile: NetworkProfile;
  /** Where this lane's money goes. */
  payTo: string;
  /** Advertise the x402 v2 PAYMENT-REQUIRED header beside the v1 body. */
  advertiseV2: boolean;
  /**
   * Facilitator override. Absent means the profile's own (x402.org on
   * testnet, CDP on mainnet); the keyless mainnet lane sets PayAI here.
   */
  facilitatorUrl?: string;
  /**
   * Surge pricing (the gate's profit guard), set on the keyless mainnet lane
   * only: PayAI bills this seller gas + 30% per settlement, so a gas spike
   * can put a $0.01 sale under water. CDP bills a flat fee and testnet
   * settles free, so neither lane needs it. `rpcUrl` is where the cost
   * oracle reads gas and the ETH/USD feed.
   */
  surge?: { rpcUrl: string };
}

export interface VendorConfig {
  port: number;
  host: string;
  /** PGlite directory. Receipts, revenue and replay slots survive a restart. */
  dataDir?: string;
  /** Public origin, so quoted resources match what agents actually requested. */
  origin?: string;
  lanes: VendorLane[];
  /** Per-payer velocity caps, applied to every lane. */
  velocity: { windowMs: number; maxPayments: number; maxAmount: string; maxAttempts: number };
  /** CDP credentials. With them the mainnet lane settles through CDP, without them through PayAI. */
  cdp?: { apiKeyId: string; apiKeySecret: string };
}

export class VendorConfigError extends Error {}

/**
 * PayAI's facilitator: keyless on Base mainnet for verify and settle (S74),
 * its response shapes proven through Rein's own FacilitatorClient by a real
 * Sepolia settlement (S75, `payai.live.test.ts`). It is the mainnet lane's
 * facilitator whenever no CDP credentials are configured.
 */
export const PAYAI_FACILITATOR_URL = 'https://facilitator.payai.network';

/**
 * The prices, in one place because they are the product.
 *
 * `/v1/ping` is deliberately the cheapest thing a real payer can buy: it is
 * what an invitee's first settled payment will be, and at $0.001 a whole
 * testnet beta costs less than a faucet drip. `/v1/scores/vendor/:host` is
 * priced higher because it is a read of accumulated evidence rather than a
 * liveness echo — and it is the first thing Rein sells that is not a demo.
 *
 * Mainnet is priced per lane because a settlement is not free there (S77).
 * The facilitator bills the SELLER gas + 30% — PayAI's Base rate was $0.00231
 * against a measured mean of $0.00234 over the 296 days since Jovian's 0.005
 * gwei base-fee floor — so a $0.001 sale loses money on every settlement, at
 * the floor alone. A sale is under water once gas exceeds price / 1.3: at
 * $0.01 that happened ~0.4% of the time (13 congestion days, 20 min to 9 h
 * each), and the floor alone reaches it only near ETH $17,900. Testnet
 * settles at $0, so its prices stay where the beta is cheapest.
 */
export const PRICES: Record<ProfileName, { ping: string; score: string }> = {
  testnet: { ping: '0.001', score: '0.005' },
  mainnet: { ping: '0.01', score: '0.02' },
};

/**
 * Default per-payer velocity: generous enough that a beta invitee never trips
 * it by using the thing, tight enough that a runaway agent with a funded
 * wallet cannot drain itself into this vendor overnight. Caps are per PAYER,
 * so one misbehaving wallet is not everyone's outage.
 */
const DEFAULT_VELOCITY = {
  windowMs: 60 * 60 * 1000,
  maxPayments: 240,
  maxAmount: '1.00',
  maxAttempts: 600,
};

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new VendorConfigError(`${name} is required`);
  return value;
}

/**
 * Is this string a plausible EVM address?
 *
 * Checked because `payTo` is where the money goes and a typo is not
 * recoverable: the facilitator will happily settle a transfer to an address
 * nobody holds the key for. A boot that refuses is cheap; a settled payment
 * into a black hole is not.
 */
function assertAddress(value: string, name: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new VendorConfigError(`${name} must be a 0x EVM address, got ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * Read the vendor's configuration.
 *
 * The mainnet lane is OPT-IN and stays off until Sprint 8. That is not
 * caution for its own sake: the two lanes differ in exactly the places that
 * are invisible until money is real (the USDC contract, the EIP-712 domain
 * name — `USDC` on Sepolia and `USD Coin` on mainnet — and which facilitator
 * settles), so the mainnet lane must be something an operator turns on
 * deliberately rather than something a default quietly arms.
 */
export function readVendorConfig(env: NodeJS.ProcessEnv): VendorConfig {
  const testnetPayTo = assertAddress(required(env, 'REIN_VENDOR_PAY_TO'), 'REIN_VENDOR_PAY_TO');
  const lanes: VendorLane[] = [
    {
      prefix: '/testnet',
      profile: profileFor('testnet'),
      payTo: testnetPayTo,
      advertiseV2: false,
    },
  ];

  if (env.REIN_VENDOR_MAINNET?.trim() === '1') {
    // A separate address by default. The treasury that takes real USDC has no
    // reason to be the same key a public testnet faucet pays into, and
    // defaulting them together is the kind of convenience that is discovered
    // later, on a wallet with real money in it.
    const mainnetPayTo = assertAddress(
      required(env, 'REIN_VENDOR_MAINNET_PAY_TO'),
      'REIN_VENDOR_MAINNET_PAY_TO',
    );
    const apiKeyId = env.REIN_CDP_API_KEY_ID?.trim();
    const apiKeySecret = env.REIN_CDP_API_KEY_SECRET?.trim();
    // Half a credential pair is a typo, not a choice. Falling back to PayAI
    // here would boot a lane on a facilitator the operator did not pick.
    if (Boolean(apiKeyId) !== Boolean(apiKeySecret)) {
      throw new VendorConfigError(
        'REIN_CDP_API_KEY_ID and REIN_CDP_API_KEY_SECRET must be set together — set both to ' +
          'settle mainnet through CDP, or neither to settle keyless through PayAI',
      );
    }
    const cdp = Boolean(apiKeyId && apiKeySecret);
    const profile = profileFor('mainnet');
    // On by default wherever PayAI settles; `off` is the escape hatch if the
    // oracle's RPC is the thing that is down and selling at a loss is the
    // lesser evil. Anything else is a typo, and a typo must not disarm it.
    const surgeSetting = env.REIN_VENDOR_SURGE?.trim();
    if (surgeSetting !== undefined && surgeSetting !== '' && surgeSetting !== 'off') {
      throw new VendorConfigError(`REIN_VENDOR_SURGE must be unset or "off", got ${JSON.stringify(surgeSetting)}`);
    }
    const surge = !cdp && surgeSetting !== 'off';
    lanes.push({
      prefix: '',
      profile,
      payTo: mainnetPayTo,
      // The v2 header carries the Bazaar listing (5.4), which requires a
      // CDP-settled v2 402, so it is advertised only when CDP settles. PayAI
      // is proven on the v1 path Rein's own payer takes; a v2 payment it
      // might mis-settle is not worth a listing it cannot give.
      advertiseV2: cdp,
      ...(cdp ? {} : { facilitatorUrl: PAYAI_FACILITATOR_URL }),
      ...(surge
        ? { surge: { rpcUrl: env.REIN_VENDOR_MAINNET_RPC_URL?.trim() || profile.defaultRpcUrl } }
        : {}),
    });
  }

  const port = Number(env.PORT ?? '8788');
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new VendorConfigError(`PORT must be a valid port number, got ${String(env.PORT)}`);
  }

  return {
    port,
    host: env.REIN_VENDOR_HOST?.trim() || '0.0.0.0',
    ...(env.REIN_VENDOR_DATA_DIR?.trim() ? { dataDir: env.REIN_VENDOR_DATA_DIR.trim() } : {}),
    ...(env.REIN_VENDOR_ORIGIN?.trim() ? { origin: env.REIN_VENDOR_ORIGIN.trim() } : {}),
    lanes,
    velocity: DEFAULT_VELOCITY,
    ...(env.REIN_CDP_API_KEY_ID?.trim() && env.REIN_CDP_API_KEY_SECRET?.trim()
      ? {
          cdp: {
            apiKeyId: env.REIN_CDP_API_KEY_ID.trim(),
            apiKeySecret: env.REIN_CDP_API_KEY_SECRET.trim(),
          },
        }
      : {}),
  };
}

/**
 * The routes one lane prices, already prefixed, each carrying its Bazaar
 * discovery block (5.4).
 *
 * The schemas are the vendor's own advertisement and the gate enforces none
 * of them — so they are written here, next to the handler's actual shape in
 * `server.ts`, and they are the thing to change when that shape changes. A
 * listing that drifts from the handler is worse than no listing: an agent
 * that read it would buy the wrong thing.
 */
export function routesFor(lane: VendorLane): GateRoute[] {
  const prices = PRICES[lane.profile.name];
  return [
    {
      path: `${lane.prefix}/v1/ping`,
      method: 'GET',
      price: prices.ping,
      description: 'Rein reference vendor — a signed liveness echo',
      mimeType: 'application/json',
      discovery: {
        input: { type: 'object', properties: {}, additionalProperties: false },
        output: {
          type: 'object',
          required: ['pong', 'network', 'at'],
          properties: {
            pong: { type: 'boolean' },
            network: { type: 'string', description: 'x402 network id this lane settles on' },
            at: { type: 'string', format: 'date-time' },
          },
        },
      },
    },
    {
      path: `${lane.prefix}/v1/scores/vendor/*`,
      method: 'GET',
      price: prices.score,
      description: 'Rein reputation — this vendor’s view of a host',
      mimeType: 'application/json',
      discovery: {
        input: {
          type: 'object',
          required: ['host'],
          properties: {
            host: { type: 'string', description: 'vendor host, as the last path segment' },
          },
        },
        // `known: false` is a real answer, not an error, and the schema says
        // so: a buyer must be able to tell "no evidence" apart from a broken
        // route BEFORE paying, or the price is not an honest one.
        output: {
          type: 'object',
          required: ['host', 'known', 'score'],
          properties: {
            host: { type: 'string' },
            known: { type: 'boolean', description: 'false when this vendor has no evidence' },
            score: {
              description: 'null when known is false',
              type: ['object', 'null'],
            },
            source: { type: 'string' },
          },
        },
      },
    },
  ];
}
