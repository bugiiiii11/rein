import { z } from 'zod';

/**
 * Chains Rein observes/governs. x402 is multi-chain; Base and Solana ship
 * first, Polygon and BNB follow. The policy/ledger domain is rail-agnostic —
 * this enum is the only place chains are enumerated.
 */
export const Chain = z.enum(['base', 'solana', 'polygon', 'bnb']);
export type Chain = z.infer<typeof Chain>;

/** Stablecoins settled over x402. */
export const Asset = z.enum(['USDC', 'USDT', 'EURC']);
export type Asset = z.infer<typeof Asset>;
