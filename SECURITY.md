# Security Policy

Rein governs an agent's authority to spend. A flaw here is not a crash — it is a payment
that should not have happened, or a payment that should have happened and was silently
blocked. We take reports seriously and we would rather hear about it early.

## Reporting a vulnerability

**Use GitHub's private vulnerability reporting** — the "Report a vulnerability" button under
[Security](https://github.com/bugiiiii11/rein/security/advisories). It opens a private
advisory only the maintainers can see.

Please do **not** open a public issue for anything that could let someone move money,
mint authority, or bypass a policy decision.

What helps, in rough order of usefulness:

- the package and version (or commit) you tested
- whether the deployment was SDK mode or signer mode (they have very different threat models — see below)
- a minimal reproduction: the policy, the intent, and what the engine or signer answered
- what you expected to happen instead

You can expect an acknowledgement within **3 working days** and an assessment within **10**.
If a fix is warranted we will agree a disclosure date with you; credit is offered by default
and declined only if you ask.

## Supported versions

Rein is pre-1.0 and ships from a single line. Security fixes land on the latest minor
release; there is no long-term support branch yet.

| Version | Supported |
|---|---|
| latest `0.x` | Yes |
| anything older | No — upgrade |

## Scope

**In scope** — the published packages and the services in this repository: the policy
engine and its decision log, the session-key signer, the gate, the SDK guard, the MCP
server, the stores, and the x402 rails.

**Out of scope** — the marketing site at reinconsole.com, the public demo console at
app.reinconsole.com (it is a read-only showcase running a scripted scenario, deliberately),
third-party facilitators and chains we do not operate, and findings that require an
attacker to already hold the credentials being protected.

## What counts as a vulnerability here

The architecture makes some behavior look alarming when it is deliberate. Reporting these
is welcome but they are known, documented, and not treated as vulnerabilities:

- **SDK mode is advisory and bypassable by design.** An agent that holds its own wallet key
  can always pay around the guard. That is why `shadow.spend` exists — the tripwire that
  makes the bypass observable. Preventing it is what the signer tier is for.
- **`@reinconsole/graph`'s reads are open on purpose.** Scores and the evidence behind them
  answer without a credential, because a reputation nobody can read governs nothing. The
  WRITE routes (`POST /v1/events`, `/v1/reports`, `/v1/links`) require an API key holding
  the `report` scope once `REIN_GRAPH_API_KEY` is set, and a graph with no key set binds
  loopback and refuses a public bind. Running one open on a public interface still works —
  `REIN_GRAPH_PUBLIC=1` — but that is then a deployment choice, not a bug.
- **The engine's signing key is stored as a plaintext PEM in the data directory** (created
  `0700`). This is the documented single-node posture; production deployments belong behind
  a KMS or HSM.
- **Wallet private keys are never persisted and no endpoint accepts one.** If you find a
  path that stores or transports one, that *is* a vulnerability — please report it.

Findings we are especially interested in: anything that releases a signature without a
valid engine-signed allow voucher, replays a spent voucher, evades a session or budget cap,
forges or breaks the decision hash chain, or turns an escalation into an approval without a
registered approver's signature.

## Security model in one paragraph

Rein is non-custodial: funds never pass through it, and it governs authority rather than
money. A `{intent, decision}` pair is a self-contained, engine-signed spend voucher that the
signer verifies fully offline and burns after one use. An approval is a signature over
`decisionId + intentHash` by a registered approver key — the delivery channel (Telegram,
say) is transport and never authority. Session grants are capped, expiring, and revocable,
with a ten-day lifetime ceiling that cannot be switched off. Everything fails closed:
an expired escalation is a denial, a store that loses a revocation refuses the token, and a
signer with no wallet in custody signs nothing.
