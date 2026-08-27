#!/usr/bin/env bash
# Creates and verifies the populated pre-purge backup for a Phase A signals
# archive batch. Refuses to run unless the batch's manifest row is already
# VERIFIED. Does not touch Neon and does not delete anything — this is the
# last gate before Phase B (purge) becomes eligible, which this script does
# not perform.
#
# Usage: scripts/phase-a-backup.sh [batch_id]
#   With no argument, uses the most recently started batch in
#   archive.signal_archive_batches.
set -euo pipefail
cd "$(dirname "$0")/.."

ARCHIVE_URL=$(grep -m1 '^MOSTAR_ARCHIVE_DATABASE_URL=' .env | sed 's/^MOSTAR_ARCHIVE_DATABASE_URL=//' | tr -d '\r' | sed 's/^["'"'"']//; s/["'"'"']$//')

BATCH_ID="${1:-}"
if [[ -z "$BATCH_ID" ]]; then
  BATCH_ID=$(psql "$ARCHIVE_URL" -Atc "SELECT batch_id FROM archive.signal_archive_batches ORDER BY started_at DESC LIMIT 1;")
fi
if [[ -z "$BATCH_ID" ]]; then
  echo "No archive.signal_archive_batches rows found." >&2
  exit 1
fi

STATUS=$(psql "$ARCHIVE_URL" -Atc "SELECT verification_status FROM archive.signal_archive_batches WHERE batch_id = '$BATCH_ID';")
echo "batch_id=$BATCH_ID verification_status=$STATUS"
if [[ "$STATUS" != "VERIFIED" ]]; then
  echo "Gate failed: verification_status is '$STATUS', not VERIFIED. Refusing to create/treat a backup as pre-purge-ready." >&2
  exit 1
fi

BACKUP_DIR="$HOME/mostar-db-backups"
mkdir -p "$BACKUP_DIR"
TS=$(date -u +%Y%m%dT%H%M%SZ)
BACKUP_FILE="$BACKUP_DIR/archive-post-copy-pre-purge-$TS.dump"

echo "--- pg_dump (schema=archive, format=custom) ---"
pg_dump "$ARCHIVE_URL" --schema=archive --format=custom --file="$BACKUP_FILE"
echo "wrote $BACKUP_FILE"

echo "--- pg_restore --list ---"
pg_restore --list "$BACKUP_FILE" >/dev/null
echo "pg_restore --list: OK"

echo "--- sha256sum ---"
sha256sum "$BACKUP_FILE"

echo "--- disposable-schema restore check ---"
RESTORE_SCHEMA="archive_restore_check_$TS"
PLAIN_SQL=$(pg_restore --format=custom -f - "$BACKUP_FILE")
# Redirect every archive-schema-qualified object into the disposable schema
# instead of the live one, so this check never touches production data.
REDIRECTED_SQL=$(printf '%s\n' "$PLAIN_SQL" | sed \
  -e "s/\bSCHEMA archive\b/SCHEMA ${RESTORE_SCHEMA}/g" \
  -e "s/\barchive\./${RESTORE_SCHEMA}./g")

psql "$ARCHIVE_URL" -X -v ON_ERROR_STOP=1 -q <<SQL
DROP SCHEMA IF EXISTS ${RESTORE_SCHEMA} CASCADE;
SQL

printf '%s\n' "$REDIRECTED_SQL" | psql "$ARCHIVE_URL" -X -v ON_ERROR_STOP=1 -q -f -

RESTORED_COUNT=$(psql "$ARCHIVE_URL" -Atc "SELECT count(*) FROM ${RESTORE_SCHEMA}.signals;")
LIVE_COUNT=$(psql "$ARCHIVE_URL" -Atc "SELECT count(*) FROM archive.signals;")
echo "restored count: $RESTORED_COUNT   live archive.signals count: $LIVE_COUNT"

psql "$ARCHIVE_URL" -X -v ON_ERROR_STOP=1 -q -c "DROP SCHEMA ${RESTORE_SCHEMA} CASCADE;"

if [[ "$RESTORED_COUNT" != "$LIVE_COUNT" ]]; then
  echo "Gate failed: restored count ($RESTORED_COUNT) != live archive.signals count ($LIVE_COUNT)." >&2
  exit 1
fi

echo ""
echo "=== Phase A backup gate report ==="
echo "batch_id                 $BATCH_ID"
echo "verification_status      $STATUS"
echo "backup file               $BACKUP_FILE"
echo "restore/count check       VERIFIED ($RESTORED_COUNT rows)"
echo ""
echo "NEON PURGE = ALLOWED (for this batch's frozen watermark only; Phase B is a separate, explicit step)"
