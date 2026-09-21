#!/usr/bin/env sh
#
# Page the founder when a scheduled run fails. Takes the message as $1.
#
# WHY THIS IS A SCRIPT AND NOT TWO COPIES OF CURL: the alarm is the only thing
# between a red nightly and nobody knowing. On 2026-09-20 and 09-21 the hosted
# engine served the console instead of the engine, and both scheduled workflows
# went red -- but only `live.yml` had an alarm, so the nightly decision-chain
# backup failed twice in silence and was found by accident two days later.
# `backup.yml` having no alarm while `live.yml` had one IS the drift, and two
# inline copies are how it happens again.
#
# WHY IT FAILS LOUDLY: the original was `curl -sS` with no `--fail`, which exits
# 0 on an HTTP 400. A revoked or rotated bot token would have made the alarm
# silently dead while the step still reported success -- and rotating that token
# is a scheduled task, so this is a matter of when, not if. An alarm nobody has
# verified is not an alarm, so a refusal here is an error annotation on the run,
# not a shrug.
#
# A MISSING TOKEN IS NOT A FAILURE (exit 0): a fork or a repo without the secret
# should not fail a run over an alarm it was never configured to send. A chat id
# missing while the token is present IS a failure -- that is a half-configured
# alarm, which looks armed and is not.
set -eu

if [ -z "${REIN_TELEGRAM_BOT_TOKEN:-}" ]; then
  echo 'no REIN_TELEGRAM_BOT_TOKEN; alarm skipped'
  exit 0
fi

if [ -z "${REIN_TELEGRAM_CHAT_ID:-}" ]; then
  echo '::error::REIN_TELEGRAM_BOT_TOKEN is set but REIN_TELEGRAM_CHAT_ID is not -- the alarm has nowhere to go'
  exit 1
fi

# --fail-with-body: non-zero exit on 4xx/5xx AND the body, which carries
# Telegram's own reason ("Unauthorized", "chat not found"). Neither the URL nor
# the token is ever echoed; the token lives in the URL and Telegram's error
# bodies do not repeat it.
if ! body=$(curl -sS --fail-with-body -X POST \
  "https://api.telegram.org/bot${REIN_TELEGRAM_BOT_TOKEN}/sendMessage" \
  -d "chat_id=${REIN_TELEGRAM_CHAT_ID}" \
  --data-urlencode "text=$1"); then
  echo "::error::the alarm could not reach Telegram: ${body}"
  exit 1
fi

# Telegram can answer 200 with {"ok":false,...}, so the status code alone is
# still not proof of delivery.
case "${body}" in
  *'"ok":true'*) echo 'alarm delivered' ;;
  *)
    echo "::error::Telegram accepted the request but refused the message: ${body}"
    exit 1
    ;;
esac
