#!/usr/bin/env bash
# Rein mainnet runner -- its wallet, agent, policy and key (Sprint 7.2, S76).
# Run from the repo root in GIT BASH:
#
#   bash scripts/runner-setup.sh
#
# Writes .env.runner (gitignored) -- the ONLY copy of a fresh mainnet private
# key. Back it up with .env.engine-ops before funding the address. Re-running
# ABORTS while the file exists: registration is not idempotent, and the engine
# has no agent-update route, so a second run mints a second agent + wallet with
# nothing pointing at the first.
#
# The agent MUST land in the org the console's read key is scoped to, or its
# settlements never show on app.reinconsole.com -- Sprint 8's gate
# (PLAN-PRODUCTION.md Sprint 8, DEPLOY.md). After the fact that is a
# re-registration, not a config change, so it is checked BEFORE anything is
# minted, and again on the agent the engine hands back.
set -euo pipefail

E=${REIN_ENGINE_URL:-https://engine.reinconsole.com}
# console-read's org = Rein's own = the pilot org (S75, read-only GET /v1/keys).
ORG=${REIN_CONSOLE_ORG_ID:-org_01M2R7WZSX0NZDVKR8PEJ97GDM}
OUT=${REIN_RUNNER_OUT:-.env.runner}
POLICY_ID=pol_runner

[ -e "$OUT" ] && { echo "FAIL: $OUT already exists -- the runner is already set up"; exit 2; }

# The pilot's org-scoped admin key (pilot-setup.sh). Reusing it mints no new
# admin credential; an unscoped bootstrap key would register the agent
# UNATTRIBUTED (S56). A real environment variable wins, which is what lets
# this be rehearsed against a local engine.
if [ -z "${REIN_RUNNER_ADMIN_KEY:-}" ]; then
  REIN_RUNNER_ADMIN_KEY=$(grep -E '^REIN_PILOT_ADMIN_KEY=' .env.pilot | cut -d= -f2- | tr -d '\r')
fi
: "${REIN_RUNNER_ADMIN_KEY:?missing -- no REIN_PILOT_ADMIN_KEY in .env.pilot}"
ADMIN=$REIN_RUNNER_ADMIN_KEY

j() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const o=JSON.parse(s);console.log(process.argv[1].split('.').reduce((a,k)=>a?.[k],o)??'')})" "$1"; }

# GET /v1/keys is admin-only and org-filtered: an org admin sees its own org's
# keys and nothing else, while an UNSCOPED key sees keys with no org at all --
# at least itself. So "every key visible is in \$ORG" proves both the scope
# and the org, and an agents-based check could not (an unscoped key passes it
# whenever every agent it can see happens to sit in one org).
echo "0/4 admin key is scoped to $ORG"
curl -sS -m 30 "$E/v1/keys" -H "Authorization: Bearer $ADMIN" | node -e "
let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
  const k=JSON.parse(s), want=process.argv[1];
  if(!Array.isArray(k)){console.error('FAIL: GET /v1/keys answered',s.slice(0,200));process.exit(1)}
  const other=k.filter(x=>x.orgId!==want);
  if(k.length===0||other.length){console.error('FAIL: this key sees',other.length,'of',k.length,'keys outside',want,'-- not an admin key scoped to that org');process.exit(1)}
})" "$ORG"

# Generated HERE and written straight to the file -- the key is never printed.
# viem resolves from x402-rails (a dependency there, not hoisted to the root).
echo "1/4 fresh Base mainnet wallet"
WALLET_LINES=$(cd services/x402-rails && node --input-type=module -e "
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
const k = generatePrivateKey();
console.log(privateKeyToAccount(k).address);
console.log(k);")
ADDRESS=$(printf '%s\n' "$WALLET_LINES" | sed -n 1p)
echo "$ADDRESS" | grep -qE '^0x[0-9a-fA-F]{40}$' || { echo "FAIL: no wallet"; exit 1; }

# The file exists from here on, so a failure below never loses the key of an
# address that may already be registered.
umask 077
cat > "$OUT" <<EOF
# Rein mainnet runner. GITIGNORED. Generated $(date -u +%Y-%m-%dT%H:%M:%SZ).
# REIN_RUNNER_PRIVATE_KEY is the ONLY copy of a Base MAINNET key -- back this
# file up before funding $ADDRESS. Load it with:  set -a; . ./$OUT; set +a
REIN_NETWORK_PROFILE=mainnet
REIN_ENGINE_URL=$E
REIN_RUNNER_ADDRESS=$ADDRESS
REIN_RUNNER_PRIVATE_KEY=$(printf '%s\n' "$WALLET_LINES" | sed -n 2p)
EOF
unset WALLET_LINES

echo "2/4 agent"
AGENT_JSON=$(curl -sS -m 30 -X POST "$E/v1/agents" \
  -H "Authorization: Bearer $ADMIN" -H 'content-type: application/json' \
  -d "{\"name\":\"mainnet-runner\",\"labels\":[\"runner\",\"pilot\"],\"wallets\":[{\"chain\":\"base\",\"address\":\"$ADDRESS\",\"mode\":\"sdk\"}]}")
AGENT=$(printf '%s' "$AGENT_JSON" | j id)
[ -n "$AGENT" ] || { echo "FAIL: no agent id: $AGENT_JSON"; exit 1; }
echo "REIN_RUNNER_AGENT_ID=$AGENT" >> "$OUT"
GOT_ORG=$(printf '%s' "$AGENT_JSON" | j orgId)
[ "$GOT_ORG" = "$ORG" ] || { echo "FAIL: $AGENT landed in '$GOT_ORG', not $ORG"; exit 1; }

# INTERIM policy, pre-funding. Default allow because the third-party host is
# whatever the catalog picks per run, so Sprint 8's `vendorHostIn` allow-list
# cannot be written yet; its escalations also need the approver keypair first.
# Sprint 8 REPLACES this by POSTing the same policyId (policies upsert by id).
# A NEW id would be ignored: evaluation takes the FIRST applicable policy.
echo "3/4 interim policy"
POL=$(curl -sS -m 30 -X POST "$E/v1/policies" \
  -H "Authorization: Bearer $ADMIN" -H 'content-type: application/json' \
  -d "{\"policyId\":\"$POLICY_ID\",\"appliesTo\":{\"agents\":[\"$AGENT\"]},\"rules\":[{\"id\":\"tx-cap\",\"deny\":{\"amountGt\":\"0.05\"}},{\"id\":\"day-budget\",\"deny\":{\"rollingSum\":{\"window\":\"24h\",\"gt\":\"1.00\"}}}],\"default\":\"allow\"}" | j policyId)
[ -n "$POL" ] || { echo "FAIL: no policyId"; exit 1; }
echo "REIN_RUNNER_POLICY_ID=$POL" >> "$OUT"

# Narrowed to the one agent: this key can submit the runner's payments and read
# its record, nothing else. It is the credential that ends up on Railway (9.5).
echo "4/4 runner key (evaluate + read, this agent only)"
KEY=$(curl -sS -m 30 -X POST "$E/v1/keys" \
  -H "Authorization: Bearer $ADMIN" -H 'content-type: application/json' \
  -d "{\"name\":\"runner-agent-key\",\"scopes\":[\"evaluate\",\"read\"],\"agentIds\":[\"$AGENT\"]}" | j secret)
[ -n "$KEY" ] || { echo "FAIL: no key secret"; exit 1; }
echo "REIN_RUNNER_API_KEY=$KEY" >> "$OUT"

cat <<EOF

OK -> $OUT
  agent   $AGENT  (org $ORG)
  policy  $POL
  wallet  $ADDRESS  (Base mainnet, UNFUNDED -- fund it in Sprint 8, not now)

Back up $OUT now. The advisory run spends nothing:
  set -a; . ./$OUT; set +a
  NODE_EXTRA_CA_CERTS=\$HOME/.rein-dev-ca.pem node apps/demo/dist/mainnet.js
EOF
