#!/usr/bin/env bash
# Rein pilot setup -- Sprint 5 exit gate (S71). Run from the repo root in GIT BASH.
# Writes .env.pilot (gitignored). Safe to re-read; NOT idempotent -- re-running
# mints duplicate keys/agents, so run it once.
set -euo pipefail

E=https://engine.reinconsole.com
WALLET=0x79f31cf1E7FfB1437DDf797a0ec7f10F335FDDcf

set -a; . ./.env.engine-ops; set +a
: "${REIN_ENGINE_API_KEY:?missing}" "${REIN_ORG_ID:?missing}"

j() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const o=JSON.parse(s);console.log(process.argv[1].split('.').reduce((a,k)=>a?.[k],o)??'')})" "$1"; }

echo "1/4 org-scoped admin key"
ADMIN=$(curl -sS -m 30 -X POST "$E/v1/keys" \
  -H "Authorization: Bearer $REIN_ENGINE_API_KEY" -H 'content-type: application/json' \
  -d "{\"name\":\"pilot-admin\",\"scopes\":[\"admin\",\"read\",\"evaluate\"],\"orgId\":\"$REIN_ORG_ID\"}" | j secret)
[ -n "$ADMIN" ] || { echo "FAIL: no admin secret"; exit 1; }

echo "2/4 agent"
AGENT=$(curl -sS -m 30 -X POST "$E/v1/agents" \
  -H "Authorization: Bearer $ADMIN" -H 'content-type: application/json' \
  -d "{\"name\":\"pilot-agent\",\"labels\":[\"pilot\"],\"wallets\":[{\"chain\":\"base\",\"address\":\"$WALLET\",\"mode\":\"sdk\"}]}" | j id)
[ -n "$AGENT" ] || { echo "FAIL: no agent id"; exit 1; }

echo "3/4 policy"
POL=$(curl -sS -m 30 -X POST "$E/v1/policies" \
  -H "Authorization: Bearer $ADMIN" -H 'content-type: application/json' \
  -d "{\"policyId\":\"pol_pilot_s71\",\"appliesTo\":{\"agents\":[\"$AGENT\"]},\"rules\":[{\"id\":\"tx-cap\",\"deny\":{\"amountGt\":\"0.50\"}},{\"id\":\"hour-budget\",\"deny\":{\"rollingSum\":{\"window\":\"1h\",\"gt\":\"0.04\"}}}],\"default\":\"allow\"}" | j policyId)
[ -n "$POL" ] || { echo "FAIL: no policyId"; exit 1; }

echo "4/4 narrowed agent key"
NARROW=$(curl -sS -m 30 -X POST "$E/v1/keys" \
  -H "Authorization: Bearer $ADMIN" -H 'content-type: application/json' \
  -d "{\"name\":\"pilot-agent-key\",\"scopes\":[\"evaluate\",\"read\"],\"agentIds\":[\"$AGENT\"]}" | j secret)
[ -n "$NARROW" ] || { echo "FAIL: no narrowed secret"; exit 1; }

cat > .env.pilot <<EOF
# Rein pilot -- Sprint 5 gate. GITIGNORED. Generated $(date -u +%Y-%m-%dT%H:%M:%SZ).
REIN_ENGINE_URL=$E
REIN_AGENT_ID=$AGENT
REIN_POLICY_ID=$POL
REIN_PILOT_ADMIN_KEY=$ADMIN
REIN_PILOT_AGENT_KEY=$NARROW
REIN_PAYER_ADDRESS=$WALLET
# REIN_PAYER_PRIVATE_KEY=0x...   <- paste your step-1 key here, then step 4b
EOF

echo
echo "OK -> .env.pilot"
echo "AGENT=$AGENT"
echo "POLICY=$POL"
