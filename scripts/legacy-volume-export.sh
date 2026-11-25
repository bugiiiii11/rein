#!/usr/bin/env bash
# E11 (docs/legal/decisions.md), ROPA row 12: the final ENCRYPTED copy of the
# legacy engine volume (/data/engine, the pre-Supabase PGlite database, frozen
# at the 2026-09-30 cutover), taken before the volume is deleted.
#
#   bash scripts/legacy-volume-export.sh <age1... recipient> [out dir]
#
# Needs: the Railway CLI, logged in (`railway login`) and linked to the project
# (`railway link`), and `age` on PATH. The recipient is the PUBLIC key behind the
# REIN_BACKUP_AGE_RECIPIENT repo secret -- the same key as the nightly dumps.
#
# What it does: tars /data/engine INSIDE the running engine container, streams
# it here as base64 (binary over `railway ssh` is not trusted), checks the
# sha256 the container computed against the bytes received, lists the archive,
# encrypts it with age, and deletes the plaintext. It only READS the volume.
#
# It does NOT delete the volume. After the .age file is stored where the founder
# keeps the backups, the deletion is a dashboard step, IN THIS ORDER:
#   1. rein-engine -> Variables: delete REIN_MIGRATE_FROM, deploy, /health keyId
#      unchanged. Load-bearing: left set, the next boot "migrates" from an EMPTY
#      directory, the target no longer continues that chain, and boot FAILS.
#   2. Leave REIN_DATA_DIR=/data/engine as it is: the bin chowns that path before
#      dropping root; without the volume it is just an unused container dir.
#   3. Detach and delete the volume, redeploy, /health keyId unchanged again.
set -euo pipefail

RECIPIENT=${1:-}
OUT=${2:-.}
SERVICE=${REIN_ENGINE_SERVICE:-rein-engine}
SRC=/data/engine

case "$RECIPIENT" in
  age1*) ;;
  *) echo "usage: $0 <age1... recipient> [out dir] -- refusing to write a plaintext copy" >&2; exit 2 ;;
esac
command -v railway >/dev/null || { echo 'railway CLI not found (npm i -g @railway/cli)' >&2; exit 2; }
command -v age >/dev/null || { echo 'age not found' >&2; exit 2; }

stamp=$(date -u +%Y-%m-%d)
name="rein-engine-volume-$stamp.tar.gz"
mkdir -p "$OUT"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

echo "== $SERVICE: $SRC on the volume"
railway ssh --service "$SERVICE" -- sh -c "du -sh $SRC && ls -la $SRC"

echo "== tar + sha256 inside the container"
remote_sum=$(railway ssh --service "$SERVICE" -- sh -c \
  "tar czf /tmp/legacy.tgz -C /data engine && sha256sum /tmp/legacy.tgz | cut -d' ' -f1" | tr -d '\r\n ')
case "$remote_sum" in
  [0-9a-f]*) [ ${#remote_sum} -eq 64 ] || { echo "bad remote sum: $remote_sum" >&2; exit 1; } ;;
  *) echo "bad remote sum: $remote_sum" >&2; exit 1 ;;
esac

echo "== transfer"
railway ssh --service "$SERVICE" -- sh -c "base64 /tmp/legacy.tgz; rm -f /tmp/legacy.tgz" \
  | tr -d '\r' | base64 -d > "$tmp/$name"

local_sum=$(sha256sum "$tmp/$name" | cut -d' ' -f1)
if [ "$local_sum" != "$remote_sum" ]; then
  echo "sha256 MISMATCH: container $remote_sum, received $local_sum -- nothing written" >&2
  exit 1
fi
echo "sha256 ok: $local_sum"

echo "== archive contents"
tar tzvf "$tmp/$name" | tail -n 25
tar tzf "$tmp/$name" >/dev/null

age -r "$RECIPIENT" -o "$OUT/$name.age" "$tmp/$name"
printf '%s  %s\n' "$local_sum" "$name" > "$OUT/$name.sha256"
echo "== wrote $OUT/$name.age (+ .sha256 of the plaintext); plaintext deleted"
echo "Next: store both with the other offline backups, then delete the volume (see header)."
