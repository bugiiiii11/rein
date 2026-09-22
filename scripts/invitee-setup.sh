#!/usr/bin/env bash
# Rein invited beta -- one invitee's org, agent, starter policy and key.
# Sprint 6 exit gate (S72). Run from the repo root in GIT BASH.
#
#   bash scripts/invitee-setup.sh <slug> [base-sepolia-wallet-address]
#
# Writes .env.invitee-<slug> (gitignored) and prints the kit to send them.
# Re-running for the same slug ABORTS: the four calls are not idempotent and a
# second run would mint a duplicate org, agent and key with nothing pointing at
# the first. Delete the env file deliberately if you really mean to redo one.
#
# The wallet is optional but there is NO route to add one later -- the engine
# has no agent-update endpoint -- so collect the invitee's Base Sepolia address
# BEFORE running this if you want it on their agent in the console. Nothing in
# evaluation reads it; settlement works without it.
set -euo pipefail

E=${REIN_ENGINE_URL:-https://engine.reinconsole.com}

SLUG=${1:-}
WALLET=${2:-}
[ -n "$SLUG" ] || { echo "usage: bash scripts/invitee-setup.sh <slug> [wallet]"; exit 2; }
echo "$SLUG" | grep -qE '^[a-z0-9][a-z0-9-]{1,30}$' || {
  echo "FAIL: slug must be a lowercase slug like 'acme' or 'acme-labs'"; exit 2; }
OUT=".env.invitee-$SLUG"
[ -e "$OUT" ] && { echo "FAIL: $OUT already exists -- this invitee is already set up"; exit 2; }

# The BOOTSTRAP key is unscoped: it is the only credential that can mint a key
# into an org that does not exist yet. A real environment variable WINS over the
# file, same convention as pilot-checks.mjs -- that is what lets this be
# rehearsed against a local engine without editing the production ops file.
if [ -z "${REIN_ENGINE_API_KEY:-}" ]; then
  set -a; . ./.env.engine-ops; set +a
fi
: "${REIN_ENGINE_API_KEY:?missing}"

j() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const o=JSON.parse(s);console.log(process.argv[1].split('.').reduce((a,k)=>a?.[k],o)??'')})" "$1"; }

# An org id is a PREFIXED ULID, not a name. `org_acme` is a 400 -- OrgId is
# `org_` + a 26-char Crockford body (packages/core/src/ids.ts:17). The org is
# created by being named here; there is no /v1/orgs route.
ORG=$(node -e "import('@reinconsole/core').then(m=>console.log(m.newId('org')))")
echo "org $ORG"

echo "1/4 org-scoped admin key"
ADMIN=$(curl -sS -m 30 -X POST "$E/v1/keys" \
  -H "Authorization: Bearer $REIN_ENGINE_API_KEY" -H 'content-type: application/json' \
  -d "{\"name\":\"$SLUG-admin\",\"scopes\":[\"admin\",\"read\",\"evaluate\"],\"orgId\":\"$ORG\"}" | j secret)
[ -n "$ADMIN" ] || { echo "FAIL: no admin secret"; exit 1; }

# Every call below uses the ADMIN key, never the bootstrap one: the CALLER's org
# is what stamps the write, so an agent registered with the unscoped bootstrap
# key lands UNATTRIBUTED -- in nobody's org, visible to operators only (S56).
echo "2/4 agent"
if [ -n "$WALLET" ]; then
  # chain is `base` even for Base Sepolia: the engine cannot tell them apart,
  # which is what REIN_NETWORK_PROFILE exists to settle on the client side.
  W=",\"wallets\":[{\"chain\":\"base\",\"address\":\"$WALLET\",\"mode\":\"sdk\"}]"
else
  W=""
fi
AGENT=$(curl -sS -m 30 -X POST "$E/v1/agents" \
  -H "Authorization: Bearer $ADMIN" -H 'content-type: application/json' \
  -d "{\"name\":\"$SLUG-agent\",\"labels\":[\"beta\"]$W}" | j id)
[ -n "$AGENT" ] || { echo "FAIL: no agent id"; exit 1; }

# The starter policy from PLAN-PRODUCTION.md Sprint 6. The hourly budget is not
# decoration: it is what walks the invitee into the DENIED the gate requires,
# after about eight $0.005 calls.
echo "3/4 starter policy"
POL=$(curl -sS -m 30 -X POST "$E/v1/policies" \
  -H "Authorization: Bearer $ADMIN" -H 'content-type: application/json' \
  -d "{\"policyId\":\"pol_${SLUG}_beta\",\"appliesTo\":{\"agents\":[\"$AGENT\"]},\"rules\":[{\"id\":\"tx-cap\",\"deny\":{\"amountGt\":\"0.50\"}},{\"id\":\"hour-budget\",\"deny\":{\"rollingSum\":{\"window\":\"1h\",\"gt\":\"0.04\"}}}],\"default\":\"allow\"}" | j policyId)
[ -n "$POL" ] || { echo "FAIL: no policyId"; exit 1; }

# This is the only key the invitee ever sees: narrowed to their one agent, so it
# can submit that agent's payments and nothing else. The admin key stays here.
echo "4/4 narrowed agent key"
NARROW=$(curl -sS -m 30 -X POST "$E/v1/keys" \
  -H "Authorization: Bearer $ADMIN" -H 'content-type: application/json' \
  -d "{\"name\":\"$SLUG-agent-key\",\"scopes\":[\"evaluate\",\"read\"],\"agentIds\":[\"$AGENT\"]}" | j secret)
[ -n "$NARROW" ] || { echo "FAIL: no narrowed secret"; exit 1; }

cat > "$OUT" <<EOF
# Rein invited beta -- $SLUG. GITIGNORED. Generated $(date -u +%Y-%m-%dT%H:%M:%SZ).
# The ADMIN key is OURS and is never sent to the invitee. The AGENT key is theirs.
REIN_ENGINE_URL=$E
REIN_INVITEE_ORG_ID=$ORG
REIN_INVITEE_AGENT_ID=$AGENT
REIN_INVITEE_POLICY_ID=$POL
REIN_INVITEE_ADMIN_KEY=$ADMIN
REIN_INVITEE_AGENT_KEY=$NARROW
EOF

cat <<EOF

OK -> $OUT

--- send this to $SLUG, and nothing above it ---------------------------------
You have a Rein beta org on the hosted engine. Follow "Path 0 -- the hosted
engine (invited)" in the quickstart:
https://reinconsole.com/agent-quickstart.md

  REIN_ENGINE_URL=$E
  REIN_AGENT_ID=$AGENT
  REIN_ENGINE_API_KEY=$NARROW
  REIN_NETWORK_PROFILE=testnet

Keep REIN_NETWORK_PROFILE=testnet. The engine cannot tell Base from Base
Sepolia; this is what stops a testnet key ever paying a mainnet 402.

1. Advisory, free: call the SDK guard or the rein_fetch MCP tool on
   https://vendor.reinconsole.com/testnet/v1/ping -- you get ALLOWED_BUT_UNPAID
   and nothing moves. The decision is already on https://app.reinconsole.com
2. Funded: get free Base Sepolia USDC at https://faucet.circle.com (no ETH
   needed -- the facilitator pays gas), set REIN_PAYER_PRIVATE_KEY, call again.
   It settles.
3. Refused: call
   https://vendor.reinconsole.com/testnet/v1/scores/vendor/api.example.com
   (\$0.005) until one is DENIED -- your policy has a \$0.04 rolling hourly
   budget, so roughly the eighth call in an hour is refused. Read the reason
   back off the error.
------------------------------------------------------------------------------

No approver is registered: POST /v1/approvers is only needed if you add an
\`escalate\` rule, and the starter policy above has none.

Verify their progress from here, any time:
  curl -sS -H "Authorization: Bearer \$REIN_INVITEE_ADMIN_KEY" \
    "$E/v1/reconciliation" | node -e "..."
  or filter decisions by policyId=$POL -- a decision row carries NO agentId.
EOF
