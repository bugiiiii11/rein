# Legal decisions

Decisions taken on legal review; the reasoning lives in the Mind Palace vault (Rein - Legal Review Response 2026-10-02, sections 9-10). This file records what the repo must honour.

## 2026-10-05 -- receiving USDC

- The reference vendor's mainnet lane (`REIN_VENDOR_MAINNET`) stays disarmed indefinitely. CBUAE PTSR Art. 2(7): a person in the UAE (UAQ FTZ included; only DIFC/ADGM excluded) may not accept a foreign payment token such as USDC for goods or services. USDC has no CBUAE-registered issuer, so no exception applies. The testnet vendor is unaffected.
- No protocol fee is implemented. A future fee is variant 1 only: a separate x402 micropayment for the decision service itself (per `/v1/decide`). Rein never enters the agent's payment to the seller; a cut of that payment (variant 2) is rejected because it would make Rein a payment intermediary.
- The fee's receiving address must be a configurable parameter, never hardcoded: the recipient will be a separate non-UAE entity chosen before monetisation (candidates ranked in the vault: DIFC/ADGM entity, Estonian OU, US LLC).
- Mainnet enablement for NEW orgs is blocked until wallet sanctions screening (at claim and at mainnet-enable) and an IP geo-block of comprehensively sanctioned territories ship. Existing invitees continue; their wallets are screened by hand and recorded in the sanctions runbook.
- A free product (no fees, no mainnet vendor) is not legally blocked: public beta and GA may proceed through the FZE.

How the mainnet block is implemented (S95): `init --mainnet` sends `mainnet: true` when it mints the agent's runtime key, and the engine refuses it (`403 mainnet_not_enabled`) unless the org is in `REIN_MAINNET_ORGS`. On the hosted engine that list is empty by default. Honest limit: the engine cannot tell Base from Base Sepolia in an intent, so someone who edits `rein-agent.json` by hand can still pay on mainnet with a sandbox key; the gate governs the supported path and the terms, not the wire. Enabling an org = screening its owner's wallet, recording the result in the sanctions runbook, then adding the org id to `REIN_MAINNET_ORGS` on Railway.

Screened by hand (record date, wallet, result, list version):

| Date | Org | Wallet | Result |
|------|-----|--------|--------|
| pending | org_01M44B9PDD1S19E7CPP7XPZCVF (Matt, pilot) | 0x3d00D335F99aC0A0998b55c82321303f660017DF | founder to run the Chainalysis sanctions check and fill this row |

## Still open

- Erasure tombstone for key names plus a deletion runbook; 18+ confirmation at claim; encrypted dumps with 90-day rotation; runbooks for data-subject requests, breach, sanctions hits and erasure; `docs/legal/ropa.md`.
- Before public GA: EU and UK representatives, a DPA template for business customers, removal of the DRAFT banner.
