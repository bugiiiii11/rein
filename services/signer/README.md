# @reinconsole/signer

The custody tier of **[Rein](https://github.com/bugiiiii11/rein)** — the control plane for AI agent payments. Wallet keys live in the signer and nowhere else; the agent holds a capped, expiring session token, and every [x402](https://www.x402.org) EIP-3009 signature is released only against an engine-signed **allow voucher for the exact transfer being signed** — verified offline, usable once.

> **Status: v0.2 — early open-source infrastructure, live on testnet.** APIs may change before 1.0. See it running: [Rein console](https://app.reinconsole.com).

## Install

```bash
npm install @reinconsole/signer
# and the engine whose decisions it verifies:
npx -p @reinconsole/policy-engine rein-policy-engine   # the rule engine on :8787
```

## Quickstart

```ts
import { SessionSigner, sessionPayerFor } from '@reinconsole/signer';
import { createGuard } from '@reinconsole/sdk';

const signer = new SessionSigner({
  enginePublicKeyPem, // the engine's decision-verification key, pinned at boot
});

// The wallet key enters here and never leaves.
signer.registerWallet(agentId, privateKey);

// A capped, expiring grant. The token is returned exactly once — only its hash is stored.
const { token } = await signer.createSession({
  agentId,
  capAmount: '25.00', // cumulative ceiling for the session's whole life
  maxPerPayment: '1.00', // ceiling per individual signature
  ttlSeconds: 3600, // default one hour; never above the signer's hard cap
});

// The agent side holds only the token. The guard's allow decision travels
// through the seam as the voucher.
const guard = createGuard({ engineUrl, agentId, apiKey, payer: sessionPayerFor(signer, token) });
```

Running the signer as its own process instead? `buildSignerServer` exposes `POST /v1/sign` plus the session-admin routes, and the agent side swaps in `createRemoteSessionPayer({ signerUrl, sessionToken })`.

## How it behaves

- **No allow, no signature.** A voucher is an engine-signed decision for one exact transfer. The signer verifies the signature offline against the pinned engine key, checks the intent hash matches the transfer it is being asked to sign, and burns the voucher on use. Replaying it fails.
- **The kill switch becomes a physical fact.** Where SDK mode _detects_ bypass after the money moves (`shadow.spend`), this tier prevents it: the agent has no key to go rogue with. Revoke the session and the next signature simply does not exist.
- **Vouchers go stale.** Decisions older than `maxDecisionAgeSeconds` (default 300s) are refused, so an agent cannot hoard allows and spend them later.
- **Two caps, both enforced at signing time.** `capAmount` bounds the session's lifetime spend; `maxPerPayment` bounds any single signature. Read the running total with `sessionSpent(id)`.
- **Session lifetime has a ceiling that cannot be switched off.** Ten days by default (`MAX_SESSION_LIFETIME_SECONDS`). An over-long `ttlSeconds` is **refused at mint**, never silently clamped — an uncapped session key is the exact blast radius this tier exists to bound.
- **The HTTP admin surface is fail-closed by construction.** `buildSignerServer` refuses to build without either a credential — an `adminToken` (≥16 chars, compared with a timing-safe digest, sent as `Authorization: Bearer` or `X-Api-Key`) or an `auth: ApiKeyAuth` — or an explicit `adminAuth: 'off'`. Those routes mint spending authority against custodied wallets, so forgetting a field cannot produce an open signer — only a deliberate statement can.
- **The credential can be scoped instead of all-or-nothing.** With `auth`, listing grants needs only `read` while minting, revoking and deleting need `admin`, so an operator dashboard carries a key that could never create a session. Keys rotate with a grace window and revoke immediately; back the store with `PgApiKeyStore` or a revocation does not survive a restart. The static `adminToken` still works beside them (it satisfies every scope) so a deployment can roll over without a flag-day.
- **Durable when you want it.** Pass [`@reinconsole/store`](https://www.npmjs.com/package/@reinconsole/store)'s session store and grants, spend accounting, revocations and burned vouchers survive a restart. **Wallet private keys are deliberately never persisted** — re-register them at boot (KMS is the production answer).
- **Refusals are typed.** Everything the signer declines throws `SignerError` with a `RefusalCode`, so the agent side can tell a cap breach from a stale voucher from a revoked session.

MIT © Rein contributors · [Repository](https://github.com/bugiiiii11/rein) · [Issues](https://github.com/bugiiiii11/rein/issues)
