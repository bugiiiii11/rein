import { describe, expect, it } from 'vitest';
import {
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  HttpRequestError,
  encodeAbiParameters,
  encodeEventTopics,
  type Address,
  type TransactionReceipt,
} from 'viem';
import { identityRegistryAbi } from './abi.js';
import { Erc8004Error } from './errors.js';
import {
  BASE_SEPOLIA_REGISTRY,
  identityRegistryReader,
  registerAgent,
  registrationRef,
  setAgentUri,
  type RegistryChainReader,
} from './registry.js';

const OWNER: Address = '0x4b64d60ee40a9bf3108c5c09cc25afc9a971958f'; // all-lowercase: checksum-exempt

/**
 * viem wraps EVERY readContract failure in ContractFunctionExecutionError —
 * a revert and a dead RPC throw the SAME wrapper type; only the cause chain
 * differs. These stubs build both shapes with viem's own error classes, so
 * the discrimination in rethrowRead is pinned against the real taxonomy.
 */
function revertError(): ContractFunctionExecutionError {
  return new ContractFunctionExecutionError(
    new ContractFunctionRevertedError({
      abi: identityRegistryAbi,
      functionName: 'ownerOf',
      message: 'ERC721NonexistentToken',
    }),
    { abi: identityRegistryAbi, functionName: 'ownerOf', args: [99n] },
  );
}

function networkError(): ContractFunctionExecutionError {
  return new ContractFunctionExecutionError(
    new HttpRequestError({ url: 'https://rpc.down.example', details: 'connection refused' }),
    { abi: identityRegistryAbi, functionName: 'ownerOf', args: [99n] },
  );
}

const throwingClient = (err: unknown): RegistryChainReader =>
  ({
    readContract: () => Promise.reject(err),
  }) as unknown as RegistryChainReader;

describe('identityRegistryReader — revert vs network discrimination', () => {
  it('a genuine revert (nonexistent token) maps to unknown_agent', async () => {
    const reader = identityRegistryReader(throwingClient(revertError()));
    await expect(reader.ownerOf(99n)).rejects.toMatchObject({ code: 'unknown_agent' });
    await expect(reader.agentURI(99n)).rejects.toMatchObject({ code: 'unknown_agent' });
  });

  it('a network failure in the SAME wrapper type stays loud — never unknown_agent', async () => {
    const reader = identityRegistryReader(throwingClient(networkError()));
    // The lenient local-fallback path in links.ts keys off Erc8004Error; a
    // dead RPC must NOT read as "not registered".
    await expect(reader.ownerOf(1n)).rejects.toSatisfy(
      (e: unknown) => !(e instanceof Erc8004Error),
    );
    await expect(reader.ownerOf(1n)).rejects.toBeInstanceOf(ContractFunctionExecutionError);
  });

  it('a plain error is rethrown untouched', async () => {
    const boom = new Error('boom');
    const reader = identityRegistryReader(throwingClient(boom));
    await expect(reader.ownerOf(1n)).rejects.toBe(boom);
  });
});

// ── registerAgent (stubbed clients — the live write is exercised by the demo) ──

function registeredLog(over: { address?: Address; tokenId?: bigint; owner?: Address } = {}) {
  const topics = encodeEventTopics({
    abi: identityRegistryAbi,
    eventName: 'Registered',
    args: { agentId: over.tokenId ?? 7393n, owner: over.owner ?? OWNER },
  });
  return {
    address: over.address ?? (BASE_SEPOLIA_REGISTRY.address as Address),
    topics,
    data: encodeAbiParameters([{ type: 'string' }], ['data:application/json,{}']),
  };
}

function stubClients(receipt: Partial<TransactionReceipt>) {
  return {
    publicClient: {
      simulateContract: () => Promise.resolve({ request: {} }),
      waitForTransactionReceipt: () => Promise.resolve(receipt),
    },
    walletClient: {
      writeContract: () => Promise.resolve('0xtxhash'),
      account: { address: OWNER },
    },
  } as unknown as Parameters<typeof registerAgent>[0];
}

describe('registerAgent — receipt decoding', () => {
  it('decodes the Registered event and formats the canonical id', async () => {
    const clients = stubClients({ status: 'success', logs: [registeredLog()] as never });
    const minted = await registerAgent({ ...clients, agentURI: 'data:application/json,{}' });
    expect(minted.tokenId).toBe(7393n);
    expect(minted.owner.toLowerCase()).toBe(OWNER.toLowerCase());
    expect(minted.erc8004Id).toBe(
      'eip155:84532:0x8004a818bfb912233c491871b3d84c89a494bd9e/7393',
    );
  });

  it('ignores Registered events from OTHER contracts in the same receipt', async () => {
    const foreign = registeredLog({ address: '0x000000000000000000000000000000000000dead' });
    const clients = stubClients({ status: 'success', logs: [foreign] as never });
    await expect(
      registerAgent({ ...clients, agentURI: 'u' }),
    ).rejects.toMatchObject({ code: 'registration_failed' });
  });

  it('a reverted tx fails honestly (not "no event")', async () => {
    const clients = stubClients({ status: 'reverted', logs: [] });
    await expect(registerAgent({ ...clients, agentURI: 'u' })).rejects.toThrow(/tx reverted/);
  });

  it('wraps arbitrary failures as registration_failed', async () => {
    const clients = stubClients({ status: 'success', logs: [] });
    (clients.publicClient as { simulateContract: unknown }).simulateContract = () =>
      Promise.reject(new Error('nonce too low'));
    await expect(
      registerAgent({ ...clients, agentURI: 'u' }),
    ).rejects.toMatchObject({ code: 'registration_failed' });
  });

  it('picks OUR Registered event out of a multi-mint receipt (owner filter)', async () => {
    // Proxy/multicall future-proofing: a batched tx can carry Registered
    // events for OTHER minters from the same registry.
    const foreignOwner = registeredLog({
      tokenId: 111n,
      owner: '0x000000000000000000000000000000000000dead',
    });
    const ours = registeredLog({ tokenId: 222n });
    const clients = stubClients({ status: 'success', logs: [foreignOwner, ours] as never });
    const minted = await registerAgent({ ...clients, agentURI: 'u' });
    expect(minted.tokenId).toBe(222n);
  });

  it('a receipt with ONLY someone else\'s Registered event fails honestly', async () => {
    const foreignOwner = registeredLog({
      owner: '0x000000000000000000000000000000000000dead',
    });
    const clients = stubClients({ status: 'success', logs: [foreignOwner] as never });
    await expect(
      registerAgent({ ...clients, agentURI: 'u' }),
    ).rejects.toMatchObject({ code: 'registration_failed' });
  });
});

// ── setAgentUri (stubbed clients, same seam as registerAgent) ────────────────

function uriUpdatedLog(over: { address?: Address; tokenId?: bigint; uri?: string } = {}) {
  const topics = encodeEventTopics({
    abi: identityRegistryAbi,
    eventName: 'URIUpdated',
    args: { agentId: over.tokenId ?? 7393n, updatedBy: OWNER },
  });
  return {
    address: over.address ?? (BASE_SEPOLIA_REGISTRY.address as Address),
    topics,
    data: encodeAbiParameters([{ type: 'string' }], [over.uri ?? 'data:application/json,{"v":2}']),
  };
}

describe('setAgentUri — receipt decoding', () => {
  it('decodes the URIUpdated event for OUR tokenId', async () => {
    const clients = stubClients({
      status: 'success',
      logs: [uriUpdatedLog({ tokenId: 41n }), uriUpdatedLog({ tokenId: 42n })] as never,
    });
    const updated = await setAgentUri({
      ...(clients as unknown as Parameters<typeof setAgentUri>[0]),
      tokenId: 42n,
      agentURI: 'data:application/json,{"v":2}',
    });
    expect(updated.tokenId).toBe(42n);
    expect(updated.agentURI).toBe('data:application/json,{"v":2}');
    expect(updated.txHash).toBe('0xtxhash');
  });

  it('a receipt without our URIUpdated event fails as registration_failed', async () => {
    const foreign = uriUpdatedLog({ address: '0x000000000000000000000000000000000000dead' });
    const clients = stubClients({ status: 'success', logs: [foreign] as never });
    await expect(
      setAgentUri({
        ...(clients as unknown as Parameters<typeof setAgentUri>[0]),
        tokenId: 7393n,
        agentURI: 'u',
      }),
    ).rejects.toMatchObject({ code: 'registration_failed' });
  });

  it('a reverted tx fails honestly', async () => {
    const clients = stubClients({ status: 'reverted', logs: [] });
    await expect(
      setAgentUri({
        ...(clients as unknown as Parameters<typeof setAgentUri>[0]),
        tokenId: 1n,
        agentURI: 'u',
      }),
    ).rejects.toThrow(/tx reverted/);
  });
});

describe('registrationRef — the registrations[] self-reference', () => {
  it('lowercases the registry and stringifies the tokenId', () => {
    expect(registrationRef(7393n)).toEqual({
      agentId: '7393',
      agentRegistry: 'eip155:84532:0x8004a818bfb912233c491871b3d84c89a494bd9e',
    });
  });
});
