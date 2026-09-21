import { describe, expect, it } from 'vitest';

import { checkServiceIdentity, ServiceIdentityError } from './identity.js';

/**
 * The outage these pin: one image, three services, and the image's default CMD
 * is the console -- so a service whose start command goes missing runs the
 * console instead, answers 200 to every probe, and reads as healthy.
 */
describe('checkServiceIdentity', () => {
  it('lets a service boot on its own environment', () => {
    expect(() =>
      checkServiceIdentity({
        service: 'the console',
        own: ['REIN_CONSOLE_DATA_DIR', 'REIN_CONSOLE_ENGINE_URL'],
        env: {
          REIN_CONSOLE_DATA_DIR: '/data/console',
          REIN_CONSOLE_READONLY: '1',
          PORT: '8080',
        },
      }),
    ).not.toThrow();
  });

  /**
   * The load-bearing one. S61 made the console fail SOFT on purpose -- a public
   * page is better up and empty than crash-looping -- and that rule is only
   * safe to keep if this guard can never fire on app.reinconsole.com. This is
   * the real console service's environment, including the S67 hosted-engine
   * link, which is the closest a legitimate console ever gets to engine config.
   */
  it('cannot fire on the public console, which must never crash-loop', () => {
    expect(() =>
      checkServiceIdentity({
        service: 'the console',
        own: ['REIN_CONSOLE_DATA_DIR', 'REIN_CONSOLE_ENGINE_URL'],
        env: {
          REIN_CONSOLE_ENGINE_URL: 'https://engine.reinconsole.com',
          REIN_CONSOLE_ENGINE_KEY: 'rk_read_...',
          REIN_CONSOLE_READONLY: '1',
          RAILWAY_RUN_UID: '0',
        },
      }),
    ).not.toThrow();
  });

  it('refuses the console on the engine deployment -- the September 2026 outage', () => {
    expect(() =>
      checkServiceIdentity({
        service: 'the console',
        own: ['REIN_CONSOLE_DATA_DIR'],
        env: { REIN_ENGINE_SIGNING_KEY: '-----BEGIN PRIVATE KEY-----', REIN_DATA_DIR: '/data/engine' },
      }),
    ).toThrow(ServiceIdentityError);
  });

  it('refuses the console on the vendor deployment', () => {
    expect(() =>
      checkServiceIdentity({
        service: 'the console',
        own: ['REIN_CONSOLE_DATA_DIR'],
        env: { REIN_VENDOR_PAY_TO: '0xtreasury' },
      }),
    ).toThrow(ServiceIdentityError);
  });

  it('names the variable and the fix, because the message is the whole diagnosis', () => {
    let message = '';
    try {
      checkServiceIdentity({
        service: 'the console',
        env: { REIN_ENGINE_SIGNING_KEY: 'x' },
      });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('REIN_ENGINE_SIGNING_KEY');
    expect(message).toContain('the hosted engine');
    expect(message).toContain('start command');
  });

  /** A marker the service owns is its own config, not evidence of a mix-up. */
  it('does not count a service its own marker', () => {
    expect(() =>
      checkServiceIdentity({
        service: 'the vendor',
        own: ['REIN_VENDOR_PAY_TO'],
        env: { REIN_VENDOR_PAY_TO: '0xtreasury', REIN_VENDOR_MAINNET: '1' },
      }),
    ).not.toThrow();
  });

  it('catches the vendor entry on the engine deployment', () => {
    expect(() =>
      checkServiceIdentity({
        service: 'the vendor',
        own: ['REIN_VENDOR_PAY_TO'],
        env: { REIN_ENGINE_SIGNING_KEY: 'x' },
      }),
    ).toThrow(ServiceIdentityError);
  });

  /** An empty variable is unset: Railway renders a cleared field as ''. */
  it('treats an empty marker as absent', () => {
    expect(() =>
      checkServiceIdentity({ service: 'the console', env: { REIN_ENGINE_SIGNING_KEY: '' } }),
    ).not.toThrow();
  });

  it('yields to an explicit opt-out and reports what it ignored', () => {
    const ignored = checkServiceIdentity({
      service: 'the console',
      env: { REIN_ENGINE_SIGNING_KEY: 'x', REIN_ALLOW_FOREIGN_SERVICE_ENV: '1' },
    });
    expect(ignored).toEqual(['REIN_ENGINE_SIGNING_KEY']);
  });

  it('accepts only "1" as the opt-out, not any truthy string', () => {
    expect(() =>
      checkServiceIdentity({
        service: 'the console',
        env: { REIN_ENGINE_SIGNING_KEY: 'x', REIN_ALLOW_FOREIGN_SERVICE_ENV: 'true' },
      }),
    ).toThrow(ServiceIdentityError);
  });
});
