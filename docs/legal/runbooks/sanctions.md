# Runbook: sanctions screening hits and hand screening

How the screening works is in `DEPLOY.md`, "Sanctions screening and the geo-block", and the decision behind it in `docs/legal/decisions.md`. This page is what the operator does. **Names, org ids and wallets go only in the private register** (MindPalace, `Projects/Rein/Rein - Legal Register.md`, "Screenings"), never in this public repo.

## A hit

The engine has already refused the step (`403 screening_refused`) and logged `[rein] SANCTIONS HIT ...`. The org did not get a claim or a mainnet key from that request.

1. **Same day:** read the record, `GET /v1/screenings?orgId=<org>` with the unscoped operator key. Note the address, its role (owner or agent), the trigger and the source.
2. **Confirm it is real.** Re-run the check by hand: call `isSanctioned(<address>)` on the Chainalysis oracle `0x40C57923924B5c5c5455c48D93317139ADDaC8fb` on Ethereum mainnet (Etherscan "Read Contract"). Check the address against the OFAC SDN search too.
3. **Close off the org** whatever the answer to step 2, until it is cleared:
   - freeze every agent in the org, `POST /v1/agents/<id>/freeze`;
   - revoke the org's keys, `POST /v1/keys/<id>/revoke` for each key `GET /v1/keys` shows with that `orgId`;
   - if the org was listed by id in `REIN_MAINNET_ORGS`, remove it and redeploy the engine.
4. **Do not tell the user why.** The refusal already says only `screening_refused`. Answer any question with: "We cannot provide this service to you." Do not mention lists, Chainalysis or sanctions.
5. **Record** in the register: date, org, address, role, trigger, the result of step 2, what was closed.
6. **Take it to counsel** the same week. Rein holds no funds and does not transfer value, so there is nothing to freeze or report as a financial institution would; whether any report is still owed (for example to the UAE Executive Office for Control and Non-Proliferation) is counsel's call, not the operator's.

## A false positive

The screen reads only exact address matches on the oracle, so a mismatch between step 2 and the engine is rare: usually the oracle changed between the two reads. If step 2 and the SDN search are both clear, record why, un-freeze, issue the user new keys, and ask counsel before re-enabling mainnet.

## Hand screening

For invitees enabled before S98 and for any org listed by id in `REIN_MAINNET_ORGS`: screen every owner and agent wallet by hand as in step 2, before enabling and again before each mainnet change. Record date, org, wallet, result and the RPC used in the register. `docs/legal/decisions.md` carries only a pointer to that row.
