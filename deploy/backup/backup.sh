#!/bin/sh
# Nightly logical backup of the hrforce database (service `backup`, image postgres:18-alpine, BusyBox sh).
#   (container entrypoint)          loop: one dump per day at BACKUP_TIME_UTC; one right away if none < 24 h old
#   /bin/sh /hrforce/backup.sh --once   one dump now (docker compose exec backup /bin/sh /hrforce/backup.sh --once)
# Output: /backups/hrforce-<UTC timestamp>.dump — pg_dump custom format (compressed, restorable table by table with
# pg_restore). Written to a .partial file, verified with `pg_restore --list`, then renamed. Dumps older than
# BACKUP_RETENTION_DAYS are deleted after each successful dump (never when the dump fails).
# Connection: PGHOST / PGPORT / PGUSER / PGPASSWORD / PGDATABASE (superuser: the dump includes the auth schema).
# Roles are cluster-level and not in the dump: they are recreated from .env by create-roles.sql (README › Restore).
set -eu

dir=${BACKUP_DIR:-/backups}
at=${BACKUP_TIME_UTC:-01:30}
keep_days=${BACKUP_RETENTION_DAYS:-14}
: "${PGDATABASE:?PGDATABASE is required}"

case $at in
  [0-2][0-9]:[0-5][0-9]) ;;
  *) echo "backup: BACKUP_TIME_UTC must be HH:MM (got '$at')" >&2; exit 2 ;;
esac
case $keep_days in
  '' | *[!0-9]*) echo "backup: BACKUP_RETENTION_DAYS must be a whole number" >&2; exit 2 ;;
esac
[ "$keep_days" -ge 1 ] || { echo "backup: BACKUP_RETENTION_DAYS must be >= 1" >&2; exit 2; }

umask 077
mkdir -p "$dir"

log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) backup: $*"; }

backup_once() {
  stamp=$(date -u +%Y%m%dT%H%M%SZ)
  file="$dir/hrforce-$stamp.dump"
  log "dumping $PGDATABASE → $file"
  if ! pg_dump --format=custom --no-password --file="$file.partial" "$PGDATABASE"; then
    rm -f "$file.partial"
    log "FAILED: pg_dump exited with an error (old dumps kept)"
    return 1
  fi
  if ! pg_restore --list "$file.partial" > /dev/null; then
    rm -f "$file.partial"
    log "FAILED: the archive is not readable by pg_restore (old dumps kept)"
    return 1
  fi
  mv "$file.partial" "$file"
  log "ok: $(du -h "$file" | cut -f1) $file"
  # -mtime +N matches files at least N+1 whole days old: keep_days=14 keeps the last 14 days of dumps.
  find "$dir" -maxdepth 1 -type f -name 'hrforce-*.dump' -mtime +"$((keep_days - 1))" -print -exec rm -f {} + \
    | sed 's/^/  pruned /'
  find "$dir" -maxdepth 1 -type f -name 'hrforce-*.dump.partial' -mmin +360 -exec rm -f {} +
}

if [ "${1:-}" = "--once" ]; then
  backup_once
  exit $?
fi

trap 'log "stopping"; exit 0' TERM INT

# A fresh install (or a host that was down at backup time) gets a dump now rather than tomorrow.
if [ -z "$(find "$dir" -maxdepth 1 -type f -name 'hrforce-*.dump' -mmin -1440 | head -n 1)" ]; then
  backup_once || true
fi

log "scheduled daily at $at UTC, keeping $keep_days days, in $dir"
last_day=""
while :; do
  if [ "$(date -u +%H:%M)" = "$at" ] && [ "$(date -u +%F)" != "$last_day" ]; then
    last_day=$(date -u +%F)
    backup_once || true
  fi
  sleep 20 &
  wait $!
done
