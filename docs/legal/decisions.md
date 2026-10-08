# Legal decisions

Decisions taken on legal review; the reasoning lives in the Mind Palace vault (Rein - Legal Review Response 2026-10-02, sections 9-10). This file records what the repo must honour.

## 2026-10-05 -- receiving USDC

- The reference vendor's mainnet lane (`REIN_VENDOR_MAINNET`) stays disarmed indefinitely. CBUAE PTSR Art. 2(7): a person in the UAE (UAQ FTZ included; only DIFC/ADGM excluded) may not accept a foreign payment token such as USDC for goods or services. USDC has no CBUAE-registered issuer, so no exception applies. The testnet vendor is unaffected.
- No protocol fee is implemented. A future fee is variant 1 only: a separate x402 micropayment for the decision service itself (per `/v1/decide`). Rein never enters the agent's payment to the seller; a cut of that payment (variant 2) is rejected because it would make Rein a payment intermediary.
- The fee's receiving address must be a configurable parameter, never hardcoded: the recipient will be a separate non-UAE entity chosen before monetisation (candidates ranked in the vault: DIFC/ADGM entity, Estonian OU, US LLC).
- Mainnet enablement for NEW orgs is blocked until wallet sanctions screening (at claim and at mainnet-enable) and an IP geo-block of comprehensively sanctioned territories ship. Existing invitees continue; their wallets are screened by hand and recorded in the sanctions runbook. (Both shipped S98; see below.)
- A free product (no fees, no mainnet vendor) is not legally blocked: public beta and GA may proceed through the FZE.

How the mainnet block is implemented (S95): `init --mainnet` sends `mainnet: true` when it mints the agent's runtime key, and the engine refuses it (`403 mainnet_not_enabled`) unless the org is in `REIN_MAINNET_ORGS`. On the hosted engine that list is empty by default. Honest limit: the engine cannot tell Base from Base Sepolia in an intent, so someone who edits `rein-agent.json` by hand can still pay on mainnet with a sandbox key; the gate governs the supported path and the terms, not the wire. Enabling an org = screening its owner's wallet, recording the result in the sanctions runbook, then adding the org id to `REIN_MAINNET_ORGS` on Railway.

How screening and the geo-block are implemented (S98, 2026-10-06). Operator detail is in DEPLOY.md, "Sanctions screening and the geo-block".

- **Wallet screening, automatic.** The hosted engine checks the owner's wallet (when they signed in with Ethereum) and every wallet the org's agents registered. It does this at claim (`/v1/claims/redeem`) and again at mainnet-enable (`POST /v1/keys` with `mainnet: true`). A hit refuses the step (`403 screening_refused`, with no list named). An unavailable check also refuses it (`503`), so the engine fails closed. Every check is stored in the `screenings` table, which is never pruned, and the operator reads it with `GET /v1/screenings`. That table replaces the hand-kept one below for every org from now on.
- **Source decided: the Chainalysis sanctions oracle** (`0x40C57923924B5c5c5455c48D93317139ADDaC8fb`, Ethereum mainnet, `isSanctioned(address)`). It was chosen over the REST API because it needs no account or key, and anyone can re-run the same check on-chain. The address goes only to an Ethereum RPC provider, not to another processor. The REST API answers a keyless request from this machine with a Cloudflare block page. Verified live 2026-10-06: a pilot org's wallet = false (recorded in the private sanctions runbook), and Lazarus Group `0x098B...2f96` = true.
- **Geo-block.** The hosted engine (every route except `/health`) and console (every request) answer `451` to IPs in the refused territories. The default set is the territories under comprehensive OFAC sanctions as of 2026-10: Cuba, Iran, North Korea, and the Crimea (UA-43, UA-40), so-called DNR (UA-14) and LNR (UA-09) regions. Syria is generated but not refused by default, because the US program was revoked in 2025. `REIN_GEOBLOCK` can add it. The data is DB-IP Lite (CC BY 4.0, attribution on the privacy page), bundled and regenerated monthly, so no address leaves the service. Region data (Crimea, Donetsk, Luhansk) is coarser than country data, and whole oblasts are refused.
- **Mainnet stays manual until the founder says go.** `REIN_MAINNET_ORGS` is unchanged, so new orgs are still refused. Adding `screened` to it admits every claimed org that passes screening. That is the switch for the soft open, and it should be thrown only once the rest of the go-live list (Terms final, runbooks, key rotation) is done.
- **Limits, stated:** IP location is defeated by a VPN, and a misfiled range can refuse someone it should not. The engine cannot see which wallet actually signs a payment, so a wallet registered after the check, or swapped into `rein-agent.json` by hand, is not screened. Counsel should confirm the territory list (UAE and EU lists included) before public GA.

Screened by hand before S98 (record date, wallet, result, list version):

| Date | Org | Wallet | Result |
|------|-----|--------|--------|
| 2026-10-05 | pilot org (row kept in the private legal register) | see register | NOT sanctioned. Chainalysis on-chain sanctions oracle `0x40C57923924B5c5c5455c48D93317139ADDaC8fb` on Ethereum mainnet, `isSanctioned(address)` = false, read via ethereum-rpc.publicnode.com. Repeat before mainnet-enable of any new org; the free REST API (api key from go.chainalysis.com, `GET https://public.chainalysis.com/api/v1/address/<addr>`) is the formal source |

## Runbooks (2026-10-08)

`docs/legal/runbooks/`: `data-subject-requests.md`, `erasure.md`, `breach.md`, `sanctions.md`. They hold procedure only. Every record they produce (requests, erasures, incidents, hand screens, hits) goes in the private legal register in the founder's vault, never in this repo.

## Still open

- 18+ confirmation at claim; encrypted dumps with 90-day rotation; `docs/legal/ropa.md`.
- Before public GA: EU and UK representatives, a DPA template for business customers, removal of the DRAFT banner.
