# Record of processing activities (GDPR Art. 30)

DRAFT -- prepared 2026-10-19 (S109) from the code and `apps/landing/privacy.html`; awaiting review in the Mind Palace legal register. Keep it in step with the privacy policy: a change to either is a change to both.

## Controller

- **Controller:** M.D.N Tech FZE, Al Shmookh Business Center, One UAQ, UAQ Free Trade Zone, Umm Al Quwain, U.A.E., licence 7813.
- **Contact:** reinconsole@proton.me.
- **EU / UK representative (Art. 27):** not appointed (open item in `decisions.md`).
- **DPO:** none appointed (open question: whether Art. 37 applies).

## Scope

Hosted services only: engine.reinconsole.com, app.reinconsole.com, vendor.reinconsole.com and reinconsole.com. Self-hosted use of the `@reinconsole/*` packages sends nothing to the controller and is outside this record.

## Activities

| # | Activity | Purpose | Data subjects | Personal data | Legal basis (GDPR / UAE PDPL) | Recipients | Retention |
|---|---|---|---|---|---|---|---|
| 1 | Sandbox provisioning (`npx @reinconsole/init`) | Create an org, agent, starter policy and API key; send test USDC | Developers | Agent wallet address; API key digests with created / last-used / expiry times; IP address (memory only, per-address daily limit) | Art. 6(1)(b) contract; 6(1)(f) abuse prevention for the IP limit / PDPL Art. 4 contract | Railway, Supabase, Base RPC providers | Records: indefinitely, as part of the decision log. Keys of an unclaimed sandbox stop working after 7 days. IP: until the limit resets or the service restarts |
| 2 | Sign-in and claim | Bind an org to its owner; let the owner see their dashboard | Owners | GitHub numeric id and username, or Ethereum address and a signed sign-in message; owner identity stored as `github:<id>` / `eth:<address>` in the owner key's name; username in the session cookie only; 18+ confirmation (checked at claim, not stored) | Art. 6(1)(b) / PDPL Art. 4 contract | GitHub (OAuth), Railway, Supabase | Owner identity: until erasure (`runbooks/erasure.md`). Cookies: `rein_session` 7 days, `rein_oauth` 10 minutes |
| 3 | Sanctions screening | Refuse sanctioned wallets at claim and at the move to mainnet | Owners; agent wallets | Wallet address, org, role (owner / agent), trigger, result, time, source | Art. 6(1)(c) legal obligation; 6(1)(f) / PDPL legal obligation | Chainalysis oracle read through Ethereum RPC providers; Supabase | Indefinitely, as evidence a check ran |
| 4 | Geo-block | Refuse requests from comprehensively sanctioned territories | Every visitor of the engine and console | IP address, looked up in a bundled table in memory | Art. 6(1)(c) / 6(1)(f) / PDPL legal obligation | None (bundled DB-IP data, no lookup service) | Not stored |
| 5 | Payment decisions (the service itself) | Evaluate each payment against the owner's policy; keep a signed, hash-linked record | Owners; sellers (hostnames may identify a person) | Decisions (outcome, reason, rules, request hash, time, signature); spending records (vendor host, resource, amount, time); escalations and the approver's signed answer; reported settlements (tx hash, chain, amount) | Art. 6(1)(b) contract; 6(1)(f) accurate audit record / PDPL Art. 4 | Railway, Supabase | Indefinitely (removing a row breaks the hash chain); resolved escalations pruned once no longer needed for enforcement |
| 6 | Reference vendor | Prove what a paying wallet paid for | Wallets paying the vendor | Paying wallet address, resource, amount, tx hash | Art. 6(1)(b) / 6(1)(f) | Railway; payment facilitators (x402.org testnet; PayAI or Coinbase mainnet) | Indefinitely, as the vendor's receipt record |
| 7 | Operational logs | Run and debug the service | All users | Request metadata; for tenant orgs only escalation ids, not their details | Art. 6(1)(f) | Railway | Railway plan retention |
| 8 | Backups | Recover the service after loss of the database | All of the above | Full engine database dump | Art. 6(1)(f) | GitHub (private repository, GitHub Actions) | Encrypted (age); 90-day rolling window on the `postgres-dumps` branch (live 2026-10-19) |
| 9 | Operator alerts | Alert the operator to failures and to escalations in Rein's own orgs | Operator | Alert text; no tenant data | Art. 6(1)(f) | Telegram | Telegram's retention |
| 10 | Data-subject requests and erasure | Answer access and erasure requests | Requesters | Request, identity proof, what was deleted and kept | Art. 6(1)(c) | None | The register kept by the operator (private) |

## Transfers outside the EU / EEA / UK and UAE

Database: Supabase, EU (Frankfurt). Railway, Vercel, GitHub and Telegram may process data in the United States or elsewhere. Mechanism as stated in the privacy policy: SCCs (+ UK Addendum / IDTA) or the EU-US Data Privacy Framework where the provider is certified; the same contractual safeguards for transfers out of the UAE. **Not yet verified per provider** -- see the open questions in the Mind Palace brief.

## Security measures (Art. 32, summary)

- No funds and no wallet or owner keys held: keys are generated on the user's machine.
- API keys stored only as digests; org-scoped keys; a read-only console by default.
- Decision log hash-linked and signed with an external engine key (public half only in the database).
- Database in a non-public schema (`rein`), Supabase Data API not exposed; backups encrypted to a key held offline by the founder; nightly restore-and-verify of every dump.
- TLS on every hosted endpoint; per-IP sandbox limits; sanctions screening and geo-block.
