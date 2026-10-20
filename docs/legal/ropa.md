# Record of processing activities (GDPR Art. 30)

DRAFT -- prepared 2026-10-19 (S109) from the code and `apps/landing/privacy.html`; revised 2026-10-20 (S110) with the Mind Palace soft-open scan (`Areas/Legal/Scans/Rein - soft-open scan 2026-10-20.md`) and Benji's L1-L9 answers. Keep it in step with the privacy policy: a change to either is a change to both. Items marked OPEN wait on a founder fact or counsel.

## Controller

- **Controller:** M.D.N Tech FZE, Al Shmookh Business Center, One UAQ, UAQ Free Trade Zone, Umm Al Quwain, U.A.E., licence 7813.
- **Contact:** reinconsole@proton.me.
- **EU / UK representative (Art. 27):** not appointed. OPEN (L1): Benji -- Art. 27 applies once EU/UK users are offered the service; appoint before mainnet opens to the public, or the founder records a conscious risk acceptance.
- **DPO:** none (L6: no large-scale special-category data; core activity is recording software agents' payment decisions).

## Scope

Hosted services only: engine.reinconsole.com, app.reinconsole.com, vendor.reinconsole.com and reinconsole.com. Self-hosted use of the `@reinconsole/*` packages sends nothing to the controller and is outside this record.

## Activities

| # | Activity | Purpose | Data subjects | Personal data | Legal basis (GDPR / UAE PDPL) | Recipients | Retention |
|---|---|---|---|---|---|---|---|
| 1 | Sandbox provisioning (`npx @reinconsole/init`) | Create an org, agent, starter policy and API key; send test USDC | Developers | Agent wallet address; API key digests with created / last-used / expiry times; IP address (memory only: per-address daily sandbox limit) | Unclaimed sandbox: 6(1)(f) primary (the user saw only the `init` Terms notice, L4); claimed org: 6(1)(b) contract. PDPL: contract, relying on the `init` notice for unclaimed sandboxes | Railway, Supabase, Base Sepolia RPC (Coinbase public endpoint) | Unclaimed sandbox: keys stop working after 7 days; org, agent (with its wallet address), policy and keys deleted 30 days later (`reaper.ts`); its decisions stay in the decision log. IP: until the limit resets or the service restarts |
| 2 | Sign-in and claim | Bind an org to its owner; let the owner see their dashboard | Owners | GitHub numeric id and username, or Ethereum address; owner identity stored as `github:<id>` / `eth:<address>` in the owner key's name and in a `session:<identity>` console key per sign-in; username in the session cookie only; the signed SIWE message is held in memory for 5 minutes and never stored; Terms acceptance (version + time) on the owner key (L5) | 6(1)(b) / PDPL Art. 4 contract | Railway, Supabase. GitHub is an independent controller for OAuth sign-in, not a recipient | Owner identity: until erasure (`runbooks/erasure.md`). Session keys: deleted a day after they expire (12 h). Terms acceptance: as long as the org exists; erasure renames the key and the record then names nobody. Cookies: `rein_session` 7 days, `rein_oauth` 10 minutes |
| 3 | Sanctions screening | Refuse sanctioned wallets at claim and at the move to mainnet | Owners; agent wallets | Wallet address, org, role (owner / agent), trigger, result, time, source | EU/UK: 6(1)(f) primary, 6(1)(c) only where an EU/UK obligation applies (OPEN, counsel, scan F14). PDPL: legal obligation | Chainalysis oracle read through Ethereum RPC providers (PublicNode, LlamaRPC, dRPC); Supabase | Indefinitely, as evidence a check ran. OPEN (E20, counsel): a fixed period. Hand-screen records: private vault (row 10) |
| 4 | Geo-block and request limits | Refuse requests from comprehensively sanctioned territories; limit requests per address | Every visitor of the engine and console | IP address, looked up in a bundled table in memory; per-IP request counter | Geo-block: as row 3. Rate limit: 6(1)(f) | None (bundled DB-IP data, no lookup service) | Geo-block: not stored. Rate limit: memory only, until the bucket refills or the service restarts |
| 5 | Payment decisions (the service itself) | Evaluate each payment against the owner's policy; keep a signed, hash-linked record | Owners; approvers; sellers (hostnames may identify a person) | Decisions (outcome, reason, rules, request hash, time, signature); spending records (vendor host, resource, amount, time); escalations and the approver's public key and signed answer; reported settlements (tx hash, chain, amount) | 6(1)(b) contract; 6(1)(f) accurate audit record / PDPL Art. 4 | Railway, Supabase | Indefinitely (removing a row breaks the hash chain). Resolved escalations pruned once no longer needed for enforcement -- OPEN (E24): state the period |
| 6 | Reference vendor (Base Sepolia only) | Prove what a paying wallet paid for | Wallets paying the vendor (users' agents or third parties) | Paying wallet address, resource, amount, tx hash; in-memory reputation scores of the parties it deals with | 6(1)(f) primary | Railway; x402.org facilitator | Indefinitely, as the vendor's receipt record. OPEN (E23): a fixed period (e.g. 12 months). Reputation: memory only |
| 7 | Operational logs | Run and debug the service | All users | Request metadata (whether client IPs are included: OPEN, Q2); for tenant orgs only escalation ids, not their details | 6(1)(f) | Railway (engine, console, vendor); Vercel (website) | Hosts' plan retention -- OPEN (Q2): state the days |
| 8 | Backups | Recover the service after loss of the database; keep a second copy of the audit trail | All of the above | Full engine database dump; nightly HTTP export of the decision log of Rein's own orgs (decision and agent ids, outcome, reason, policy id, hashes, signatures) | 6(1)(f) | GitHub (private repository, GitHub Actions) | Dumps: encrypted (age), 90-day rolling window on the `postgres-dumps` branch (live 2026-10-19). Decision export: encrypted (age) from S110, kept indefinitely like the decision log (L9); pre-S110 plaintext exports stay in git history until purged. The L7 purge was a force-push: GitHub may keep unreachable commits until its support purges them (OPEN, Q8) |
| 9 | Operator alerts | Alert the operator to failures and to escalations in Rein's own orgs | Operator | Alert text; no tenant data | 6(1)(f) | Telegram | Telegram's retention |
| 10 | Data-subject requests and erasure | Answer access and erasure requests | Requesters | Request, identity proof, what was deleted and kept | 6(1)(c) (the duty is in the GDPR itself) | GitHub (the register lives in the Mind Palace vault, a private GitHub repo since 2026-10-15) | Proposed: 3 years after the request is closed (a choice, not a statute) |
| 11 | Website delivery | Serve reinconsole.com | Visitors | IP address and browser details, in the host's request logs | 6(1)(f) | Vercel | Vercel's log retention |
| 12 | Legacy engine volume | Rollback copy of the pre-Supabase PGlite database (`/data/engine`) | Agent wallets; sellers | The engine database as of the 2026-09-30 cutover. No owner identities: claim shipped after the cutover | 6(1)(f) | Railway | OPEN (Q5): recommended -- final encrypted copy into the 90-day rotation, then delete the volume |
| 13 | Incident register | Record personal-data breaches (`runbooks/`) | Affected users | Incident facts, affected data, notifications | 6(1)(c) | GitHub (private vault) | OPEN: set a period |

The console volume (`/data/console`) was destroyed in S70; the production console holds no data of its own.

## Transfers outside the EU / EEA / UK and UAE

Database: Supabase, EU (Frankfurt). The privacy policy (S110 wording) claims only "the safeguard that provider offers in its data processing terms", and names GitHub sign-in, blockchain networks, RPC nodes and facilitators as independent recipients with no transfer agreement. Per provider, all **unverified** until the current DPA is opened and its version and date recorded in the vault:

| Provider | Role | Mechanism (as far as known) | Action |
|---|---|---|---|
| Supabase | Processor (database) | DPA with SCCs + UK addendum | Sign the DPA in the dashboard and file it (Q3) |
| Railway | Processor (compute, logs, volumes) | Published DPA with SCCs | Confirm plan, region (Q1), DPF status |
| Vercel | Processor (website) | DPA with SCCs + UK addendum | Confirm plan (Q4) |
| GitHub | Processor (backups, Actions); independent controller for OAuth | DPF + SCCs in the GitHub DPA; coverage of a personal account unclear | Check which terms govern the backup repo's account |
| Telegram | Not a processor of user data (operator alerts only) | None | Keep it out of the transfer claim |
| RPC nodes, facilitators | Independent recipients | None | Covered by the policy wording |

## Security measures (Art. 32, summary)

- No funds and no wallet or owner keys held: keys are generated on the user's machine.
- API keys stored only as digests; org-scoped keys; a read-only console by default.
- Decision log hash-linked and signed with an external engine key (public half only in the database).
- Database in a non-public schema (`rein`), Supabase Data API not exposed; backups and the decision export encrypted to a key held offline by the founder; nightly restore-and-verify of every dump.
- TLS on every hosted endpoint; per-IP sandbox and request limits; sanctions screening and geo-block.
