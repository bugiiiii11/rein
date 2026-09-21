/**
 * Refuse to run as the wrong service.
 *
 * THE FAILURE THIS EXISTS FOR (2026-09-19 to 2026-09-21, three days live).
 * Every Rein service is built from ONE image, and that image's default CMD is
 * the console. Each service overrides it with a start command -- but the engine
 * service's start command went missing from the Railway dashboard, so Railway
 * fell back to the image CMD and `engine.reinconsole.com` came up serving the
 * console. It answered every request with the console's SPA at status 200.
 *
 * Nothing detected it, and nothing could have:
 *
 *   - Railway's healthcheck passed, because the console serves index.html for
 *     any unmatched path, `/health` included, with a 200.
 *   - No healthcheck PATH can fix that. There is no path a console 404s.
 *   - The deploy was green. The service was "Online". The only symptom was
 *     two scheduled workflows failing on a JSON parse error two days later.
 *
 * So the check cannot live in a route or in a probe. It has to happen in the
 * process, before it serves, which is here.
 *
 * WHAT IT KEYS ON. Not a declared name -- a variable that must be SET for the
 * deploy to be correct is worth nothing as a signal, because the failure being
 * caught IS configuration going missing. Instead each service is identified by
 * a variable it cannot run without and no other service has any use for:
 *
 *   REIN_ENGINE_SIGNING_KEY   the hosted engine. Without it the engine refuses
 *                             to boot entirely (S53), so it is always present.
 *   REIN_VENDOR_PAY_TO        the vendor's treasury. `readVendorConfig` rejects
 *                             a vendor without one, so likewise.
 *
 * Both are meaningless to a console. Finding one means this process is running
 * on another service's environment.
 *
 * WHY IT REFUSES TO BOOT, given S61 made the console fail SOFT on purpose.
 * That rule protects app.reinconsole.com: a public page is better up and empty
 * than crash-looping. This guard cannot fire there. The console's own service
 * has REIN_CONSOLE_* and neither marker above, so the only process it can ever
 * stop is one already serving the wrong thing under someone else's hostname --
 * where staying up is not resilience, it is a masked outage that looks healthy.
 * A crash-loop is also the one signal Railway does surface as a failed deploy.
 *
 * It is deliberately NOT wired into the engine's bin. An engine started on the
 * wrong service fails closed already, on the missing signing key.
 *
 * The opt-out exists because a single box running two services from one
 * exported environment is a legitimate self-hoster shape, and this guard should
 * not be the thing that breaks it. It follows the signer's rule from S48:
 * refuse, or be told explicitly not to.
 */

/** Marker variable -> the service it belongs to. */
const MARKERS: ReadonlyArray<readonly [string, string]> = [
  ['REIN_ENGINE_SIGNING_KEY', 'the hosted engine'],
  ['REIN_VENDOR_PAY_TO', 'the vendor'],
];

const OPT_OUT = 'REIN_ALLOW_FOREIGN_SERVICE_ENV';

export interface ServiceIdentityOptions {
  /** The service this entry point IS, named as it appears in the message. */
  service: string;
  /** Marker variables belonging to this service, which are therefore allowed. */
  own?: readonly string[];
  env?: Record<string, string | undefined>;
}

export class ServiceIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ServiceIdentityError';
  }
}

/**
 * Throws when `env` carries a marker for a service other than `service`.
 * Returns the foreign markers it ignored when opted out, for logging.
 */
export function checkServiceIdentity({
  service,
  own = [],
  env = process.env,
}: ServiceIdentityOptions): string[] {
  const foreign = MARKERS.filter(
    ([name]) => !own.includes(name) && (env[name] ?? '') !== '',
  );
  if (foreign.length === 0) return [];

  if ((env[OPT_OUT] ?? '') === '1') return foreign.map(([name]) => name);

  const found = foreign.map(([name, owner]) => `${name} (${owner})`).join(', ');
  throw new ServiceIdentityError(
    `refusing to start: this process is ${service}, but its environment carries ${found}. ` +
      `That means ${service} is running on another service's deployment -- almost always a ` +
      `missing start command, which falls back to the image's default CMD. Set the start ` +
      `command for this service, or set ${OPT_OUT}=1 if one environment really does host both.`,
  );
}
