# Runbook: data-subject requests

Access, correction, deletion, objection, restriction or a copy, under the GDPR/UK GDPR or the UAE PDPL. What we hold is listed in `apps/landing/privacy.html`, "What we collect".

**Never record a requester's identity, org id or wallet in this repo -- it is public.** Every request goes in the private register (MindPalace, `Projects/Rein/Rein - Legal Register.md`, "Requests").

## Deadlines

- Acknowledge within 3 working days.
- Answer within **one month** of receipt (GDPR Art. 12(3)); the PDPL says "without undue delay", so one month covers both. Extend by two months only for a complex request, and say so within the first month.
- Free of charge, unless a request is manifestly unfounded or excessive (state why in the reply).

## Steps

1. **Log it** in the register: date received, channel (reinconsole@proton.me or post), right asked for, deadline.
2. **Verify the requester** against what we hold, proportionately:
   - GitHub sign-in: they sign in at app.reinconsole.com with the account that claimed the org, and the console shows their org. Or they email from an address their GitHub profile shows publicly.
   - Ethereum sign-in: they sign a message we choose (include the date and the request reference) with the owner wallet; check it with any EIP-191 verifier.
   - Sandbox only (never claimed): the org admin key in `rein-agent.json` proves control. Ask them to call `GET /v1/keys` with it and send us the `orgId`, never the key.
   - Cannot verify: say what is missing and stop the clock until they provide it.
3. **Find their data** with the unscoped operator key (`REIN_ENGINE_API_KEY` in `.env.engine-ops`):
   - The owner key: `GET /v1/keys` lists keys named `owner:github:<id>` or `owner:eth:<address>`; it carries the `orgId`.
   - Then, with `?orgId=` where the route takes it: agents (wallets), policies, decisions, approvals, reconciliation, and `GET /v1/screenings?orgId=<org>`.
   - Reference vendor receipts hold paying wallet addresses only; search them by address if the requester names one.
4. **Act on the right asked for:**
   - **Access / copy:** export the rows above as JSON and send them, with the categories, purposes, recipients and retention periods from the privacy policy.
   - **Correction:** a policy or agent name the owner can change themselves with their admin key; anything else, fix and note it.
   - **Deletion:** follow `erasure.md`. Say plainly what is kept and why (decision log, screening records).
   - **Objection / restriction:** decision-log processing continues on its compelling-grounds basis (integrity of the record); anything else, stop and note it.
5. **Reply** from reinconsole@proton.me. Close the register row with the date and what was done.

## Escalate

A request from an authority, a lawyer, or anyone claiming to act for someone else: do not answer the substance. Log it, acknowledge receipt, and take it to counsel.
