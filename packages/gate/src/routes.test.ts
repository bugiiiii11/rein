import { describe, it, expect } from 'vitest';
import { matchRoute, requirementFor, type GateRoute, type PaymentDefaults } from './routes.js';

const defaults: PaymentDefaults = {
  payTo: '0xVENDOR',
  network: 'base',
  asset: 'USDC',
};

describe('matchRoute', () => {
  const routes: GateRoute[] = [
    { path: '/api/premium/*', method: 'POST', price: '0.25' },
    { path: '/api/premium/*', price: '0.10' },
    { path: '/api/answer', price: '0.05' },
  ];

  it('matches glob paths, first match wins', () => {
    expect(matchRoute(routes, 'POST', '/api/premium/forecast')?.price).toBe('0.25');
    expect(matchRoute(routes, 'GET', '/api/premium/forecast')?.price).toBe('0.10');
    expect(matchRoute(routes, 'GET', '/api/answer')?.price).toBe('0.05');
  });

  it('treats method case-insensitively and unmatched paths as free', () => {
    expect(matchRoute(routes, 'post', '/api/premium/x')?.price).toBe('0.25');
    expect(matchRoute(routes, 'GET', '/health')).toBeUndefined();
    expect(matchRoute(routes, 'GET', '/api/answers')).toBeUndefined(); // no glob, no match
  });
});

describe('requirementFor', () => {
  it('builds a strict v1 quote from route + defaults', () => {
    const requirement = requirementFor(
      { path: '/api/answer', price: '0.05', description: 'one answer' },
      defaults,
      'https://api.vendor.test/api/answer',
    );
    expect(requirement).toMatchObject({
      scheme: 'exact',
      network: 'base',
      maxAmountRequired: '50000',
      resource: 'https://api.vendor.test/api/answer',
      description: 'one answer',
      mimeType: 'application/json',
      payTo: '0xVENDOR',
      maxTimeoutSeconds: 300,
      asset: 'USDC',
    });
  });

  it('lets a route override every payment default', () => {
    const requirement = requirementFor(
      {
        path: '/sol/*',
        price: '1.5',
        payTo: 'SoLVendor111',
        network: 'solana',
        asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        maxTimeoutSeconds: 60,
      },
      defaults,
      'https://api.vendor.test/sol/quote',
    );
    expect(requirement).toMatchObject({
      network: 'solana',
      payTo: 'SoLVendor111',
      maxAmountRequired: '1500000',
      maxTimeoutSeconds: 60,
    });
  });

  it('stamps non-standard decimals into extra so payers price correctly', () => {
    const requirement = requirementFor(
      { path: '/x', price: '2', decimals: 2 },
      defaults,
      'https://v.test/x',
    );
    expect(requirement.maxAmountRequired).toBe('200');
    expect(requirement.extra).toMatchObject({ decimals: 2 });
  });

  it('merges extra with route taking precedence over gate defaults', () => {
    const requirement = requirementFor(
      { path: '/x', price: '1', extra: { version: '2' } },
      { ...defaults, extra: { name: 'USDC', version: '1' } },
      'https://v.test/x',
    );
    expect(requirement.extra).toEqual({ name: 'USDC', version: '2' });
  });
});
