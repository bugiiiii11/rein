/**
 * The reference vendor's entrypoint (Sprint 5.3).
 *
 * Three things happen here and nowhere else: the privilege drop, the durable
 * store, and the drain. Everything about what the vendor SELLS is in
 * `config.ts` and `server.ts`, which stay socket-free and testable.
 */
import { checkServiceIdentity, dropPrivileges } from '@reinconsole/boot';
import { openReinStore, type ReinStore } from '@reinconsole/store';
import { readVendorConfig, VendorConfigError } from './config.js';
import { createVendorServer } from './server.js';

// The vendor's own marker is REIN_VENDOR_PAY_TO, so this catches the vendor
// entry running on the ENGINE's deployment. The reverse -- the console's CMD
// taking over this service -- is caught by the same check in the console.
checkServiceIdentity({ service: 'the vendor', own: ['REIN_VENDOR_PAY_TO'] });

const config = (() => {
  try {
    return readVendorConfig(process.env);
  } catch (err) {
    if (err instanceof VendorConfigError) {
      // A misconfigured vendor must not boot. Unlike the console — a public
      // page that is better up and empty than crash-looping — every route
      // here takes money, and a half-configured one takes it to the wrong
      // address or on the wrong chain.
      console.error(`[vendor] ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
})();

// Railway volumes are BIND MOUNTS and land root-owned even when brand new
// (S59), so the container starts as root, chowns its tree, and becomes `node`
// HERE — inside the container that will serve, at the one moment no other
// writer exists. Fails soft: staying root is the pre-drop production state,
// and crash-looping a paid API is worse than running as root for one deploy.
if (config.dataDir) {
  dropPrivileges({ dataDir: config.dataDir, log: (m) => console.warn(m) });
}

// Must stay AFTER the drop: an already-open root-owned handle is the one
// thing the drop cannot repair.
let store: ReinStore | undefined;
if (config.dataDir) {
  store = await openReinStore({ dir: config.dataDir });
}

const vendor = createVendorServer({
  config,
  // One gate store, shared by both lanes. Receipts carry their own network,
  // and the replay slots that matter most are the ones that must survive a
  // redeploy — a burned authorization nonce is not re-burnable, so losing the
  // table on restart would reopen every replay this vendor has already
  // refused.
  ...(store ? { storeFor: () => store.gate } : {}),
});

const port = await vendor.listen();
console.log(
  `[vendor] listening on http://${config.host}:${port} (pid ${process.pid}) — lanes: ` +
    config.lanes.map((l) => `${l.profile.name}${l.prefix || ' (/)'}`).join(', '),
);
for (const l of config.lanes) {
  console.log(`[vendor] ${l.profile.name} settles via ${l.facilitatorUrl ?? l.profile.facilitatorUrl}`);
}
if (!config.lanes.some((l) => l.profile.name === 'mainnet')) {
  console.log('[vendor] mainnet lane is OFF — set REIN_VENDOR_MAINNET=1 to arm it (Sprint 8)');
}

/**
 * Graceful shutdown. The gate's write-behind tail holds settled receipts that
 * are already money moved on chain: dying undrained loses the vendor's own
 * record of a payment the payer can prove. See the console's standalone.ts
 * for why `server.close()` alone would hang and why the exit is deferred.
 */
let closing = false;
const shutdown = async (signal: string): Promise<void> => {
  if (closing) return;
  closing = true;
  console.log(`[vendor] ${signal} received — draining`);

  const abandon = setTimeout(() => {
    console.error('[vendor] drain timed out after 10s — exiting with receipts possibly unflushed');
    process.exit(1);
  }, 10_000);
  abandon.unref();

  try {
    await vendor.close();
    await store?.close();
    clearTimeout(abandon);
    console.log('[vendor] drained, exiting cleanly');
    process.exitCode = 0;
    setTimeout(() => process.exit(0), 2000).unref();
  } catch (err) {
    console.error('[vendor] drain failed (receipts may be lost):', err);
    process.exitCode = 1;
    setTimeout(() => process.exit(1), 2000).unref();
  }
};

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
