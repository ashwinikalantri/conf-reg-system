#!/usr/bin/env bash
# Nightly backup of the NQOCN 2026 database and file uploads.
#
# Runs the work INSIDE a container built from the app image (which carries
# node+sqlite3 and rclone), so there is one runtime to maintain rather than
# also depending on the host's Node and the host checkout's node_modules.
#
# Deliberately `docker run --rm` off the IMAGE rather than `docker compose
# exec` into the running app container (which is how scripts/daily-digest.sh
# invokes the digest). Two reasons, both about this being the disaster-
# recovery path:
#   1. A backup must still run when the app container is unhealthy, crashed,
#      or stopped -- which is exactly when you most want one. `exec` would
#      fail in precisely that situation; a fresh container off the image does
#      not care about the app container's state.
#   2. It keeps the Google Drive credential out of the long-running,
#      internet-facing app container. The rclone remote is scoped to the
#      whole Drive, so its token is mounted only into this short-lived
#      backup container, and only read-only, instead of sitting mounted on
#      the web-facing service around the clock.
#
# Backups land outside the repo (never something git should touch or a
# `git clean` could sweep up) since they contain delegate PII: phone
# numbers, UTRs, and payment screenshots / ID cards.
set -euo pipefail

# cron runs with a minimal PATH that doesn't include /usr/local/bin, where
# docker/rclone live -- without this the whole run silently no-ops.
export PATH="/usr/local/bin:/usr/bin:/bin:$PATH"

APP_DIR="/home/ashwinikalantri/nqocn"
BACKUP_ROOT="/home/ashwinikalantri/nqocn-backups"
DATA_VOLUME="nqocn_data"
IMAGE="nqocn-app"
RCLONE_CONF="/root/.config/rclone/rclone.conf"
RETENTION_DAYS=14
# Google Drive keeps a COUNT, not an age: the most recent DRIVE_KEEP backups,
# whatever their dates. Age-based pruning off-site would empty the remote
# during any stretch where backups stopped running -- precisely when the old
# ones are the only ones left.
DRIVE_REMOTE="nqocn-db:NQOCN 2026 Backups"
DRIVE_KEEP=14
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
DEST="$BACKUP_ROOT/$TIMESTAMP"
LOG_FILE="$BACKUP_ROOT/backup.log"

# --dry-run  : do everything except delete anything from Google Drive; log
#              what would go instead. Use it before trusting the retention.
# --prune-only: skip taking a backup, just apply Drive retention.
DRY_RUN=0
PRUNE_ONLY=0
FORCE_MANUAL=0
IF_REQUESTED=0
for arg in "$@"; do
  case "$arg" in
    --dry-run)    DRY_RUN=1 ;;
    --prune-only) PRUNE_ONLY=1 ;;
    --manual)     FORCE_MANUAL=1 ;;
    --if-requested) IF_REQUESTED=1 ;;
    -h|--help)
      echo "Usage: backup.sh [--dry-run] [--prune-only]"
      echo "  (no flags)    take a backup, upload it, then keep the newest $DRIVE_KEEP on Drive"
      echo "  --dry-run     never delete from Drive; log what would be deleted"
      echo "  --prune-only  don't back up, only apply Drive retention"
      echo "  --manual      label this run 'manual' in the log (implied by a terminal)"
      echo "  --if-requested  run only if the admin panel has queued a backup, then clear it"
      exit 0 ;;
    *) echo "Unknown option: $arg (try --help)" >&2; exit 2 ;;
  esac
done

# Manual runs are logged as such, so an unexpected backup in the log can be
# told apart from the 02:00 cron one.
# A terminal means a person ran it; --manual covers anything else that is not
# the 02:00 cron entry. Only a log label, nothing branches on it.
RUN_KIND="scheduled"
{ [ -t 1 ] || [ "$FORCE_MANUAL" -eq 1 ]; } && RUN_KIND="manual"

mkdir -p "$BACKUP_ROOT"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG_FILE"; }

# --- Handshake with the admin panel ---------------------------------------
# "Back up now" in Settings writes .backup-request.json into the data volume;
# this reads it, and afterwards writes .backup-status.json back so the panel
# can report when the last backup ran and whether it worked. Both touch only
# those two dot-files -- the volume is otherwise never written by this script.
volume_read()  { docker run --rm -v "$DATA_VOLUME":/data:ro "$IMAGE" sh -c "cat /data/$1 2>/dev/null" 2>/dev/null; }
volume_clear() { docker run --rm -v "$DATA_VOLUME":/data "$IMAGE" sh -c "rm -f /data/$1" >/dev/null 2>&1; }
# -i is required: without it docker never attaches stdin, so the `cat` inside
# the container reads EOF straight away and writes an empty file.
volume_write() { docker run --rm -i -v "$DATA_VOLUME":/data "$IMAGE" sh -c "cat > /data/$1" >/dev/null 2>&1; }

REQUESTED_BY=""
if [ "$IF_REQUESTED" -eq 1 ]; then
  REQUEST_JSON="$(volume_read .backup-request.json || true)"
  if [ -z "$REQUEST_JSON" ]; then
    exit 0   # nothing queued; stay silent so the log isn't a wall of no-ops
  fi
  REQUESTED_BY="$(printf '%s' "$REQUEST_JSON" | sed -n 's/.*"requestedBy":"\([^"]*\)".*/\1/p')"
  RUN_KIND="manual"
  log "Backup requested from the admin panel${REQUESTED_BY:+ by $REQUESTED_BY}"
  # Cleared BEFORE the work, not after: if this run dies halfway the request
  # is spent rather than retried forever on every poll.
  volume_clear .backup-request.json
fi

# Only now that we know this run is really happening: an --if-requested poll
# with nothing queued has already exited, without logging a line or leaving an
# empty timestamped directory behind. It runs every few minutes, so anything
# it does unconditionally it does ~288 times a day.
[ "$PRUNE_ONLY" -eq 1 ] || mkdir -p "$DEST"

log "Starting $RUN_KIND backup -> $DEST"

UPLOAD_OK=0

if [ "$PRUNE_ONLY" -eq 1 ]; then
  log "Prune-only run: skipping backup, applying Drive retention."
else

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  log "ERROR: image '$IMAGE' not found -- build it with 'docker compose build'. Nothing backed up."
  exit 1
fi

# One container does the DB dump and both tarballs. The data volume is
# mounted READ-ONLY: this process must never be able to damage live data,
# and everything here only reads from it. Output goes to the host backup
# directory mounted at /backups.
#
# Database: VACUUM INTO, not a file copy -- transactionally consistent, so
# it is safe to take while the app is live and mid-write. The source is
# opened OPEN_READONLY to match the read-only mount.
if ! docker run --rm \
  -v "$DATA_VOLUME":/data:ro \
  -v "$BACKUP_ROOT":/backups \
  -w /data \
  "$IMAGE" \
  sh -c "
    set -e
    if [ -f /data/conference.db ]; then
      node -e \"
        const sqlite3 = require('/app/node_modules/sqlite3').verbose();
        const db = new sqlite3.Database('/data/conference.db', sqlite3.OPEN_READONLY);
        db.run(\\\"VACUUM INTO '/backups/$TIMESTAMP/conference.db'\\\", (err) => {
          if (err) { console.error(err.message); process.exit(1); }
          db.close();
        });
      \"
    else
      echo 'WARNING: conference.db not found in the data volume' >&2
    fi
    for dir in uploads bank-statements; do
      if [ -d \"/data/\$dir\" ] && [ -n \"\$(ls -A \"/data/\$dir\" 2>/dev/null)\" ]; then
        tar -czf \"/backups/$TIMESTAMP/\$dir.tar.gz\" -C /data \"\$dir\"
      fi
    done
  " >> "$LOG_FILE" 2>&1; then
  log "ERROR: backup container failed -- see above"
  exit 1
fi

[ -f "$DEST/conference.db" ] && log "Database backed up ($(du -h "$DEST/conference.db" | cut -f1))"
for dir in uploads bank-statements; do
  [ -f "$DEST/$dir.tar.gz" ] && log "$dir/ archived ($(du -h "$DEST/$dir.tar.gz" | cut -f1))"
done

# Off-site copy to Google Drive (rclone remote "nqocn-db"). Uses `copy`, not
# `sync` -- copy only ever adds files, never deletes from the destination, so
# Drive keeps every night's backup even after local pruning (below) removes
# it here. That way a mistake in the local retention logic (or the server
# itself failing) can't also wipe the off-site copy. Non-fatal: the local
# backup already succeeded by this point, so a Drive/network hiccup
# shouldn't fail the whole run.
#
# Runs in its own container with the rclone config mounted read-only, and
# only the finished backup directory (not the live data volume) exposed.
#
# The config is COPIED to a writable path inside the container before use.
# rclone refreshes the Drive access token on every run and tries to save it
# back; against a read-only mount that failed noisily each night ("device or
# resource busy"), which is exactly the kind of recurring error that trains
# you to ignore the log. The copy dies with the container, so the host's
# credential is still never modified.
if [ -f "$RCLONE_CONF" ]; then
  if docker run --rm \
    -v "$RCLONE_CONF":/rclone.conf:ro \
    -v "$DEST":/backup:ro \
    "$IMAGE" \
    sh -c 'cp /rclone.conf /tmp/rclone.conf && exec rclone --config /tmp/rclone.conf copy /backup "$0/$1"' \
    "$DRIVE_REMOTE" "$TIMESTAMP" >> "$LOG_FILE" 2>&1; then
    log "Synced to Google Drive ($DRIVE_REMOTE/$TIMESTAMP)"
    UPLOAD_OK=1
  else
    log "WARNING: Google Drive sync failed -- local backup is still intact"
  fi
else
  log "Skipping Google Drive sync -- $RCLONE_CONF not found"
fi

fi  # end of the backup+upload work skipped by --prune-only

# Prune LOCAL backups older than RETENTION_DAYS -- one directory per run,
# named by timestamp, so this only ever touches backup dirs, never the DB/app.
if [ "$PRUNE_ONLY" -eq 0 ]; then
  find "$BACKUP_ROOT" -maxdepth 1 -type d -name '20*' -mtime "+$RETENTION_DAYS" -print -exec rm -rf {} \; >> "$LOG_FILE" 2>&1
fi

# Prune GOOGLE DRIVE down to the newest $DRIVE_KEEP backups.
#
# Deleting from the off-site copy is the one irreversible thing this script
# does, so it is fenced in:
#   * it only runs after THIS run's upload succeeded (or in --prune-only),
#     so a spell of failing uploads can never quietly eat the history;
#   * only directories whose names are exactly a backup timestamp are ever
#     considered, so anything else living in that Drive folder is untouched;
#   * timestamp names sort lexicographically in chronological order, so
#     "newest N" is just the tail of a sorted list -- no date parsing;
#   * if the listing comes back empty, or proposes deleting an implausible
#     number at once, it stops and says so rather than acting on what is
#     probably a bad listing.
prune_drive() {
  if [ ! -f "$RCLONE_CONF" ]; then
    log "Skipping Drive retention -- $RCLONE_CONF not found"
    return 0
  fi
  if [ "$PRUNE_ONLY" -eq 0 ] && [ "$UPLOAD_OK" -eq 0 ]; then
    log "Skipping Drive retention -- this run did not upload, so nothing is pruned"
    return 0
  fi

  local listing
  if ! listing="$(docker run --rm \
      -v "$RCLONE_CONF":/rclone.conf:ro \
      "$IMAGE" \
      sh -c 'cp /rclone.conf /tmp/rclone.conf && exec rclone --config /tmp/rclone.conf lsf --dirs-only "$0"' \
      "$DRIVE_REMOTE" 2>>"$LOG_FILE")"; then
    log "WARNING: could not list $DRIVE_REMOTE -- retention skipped this run"
    return 0
  fi

  # Backup directories only: YYYYMMDD-HHMMSS, nothing else.
  local all
  all="$(printf '%s\n' "$listing" | tr -d '\r' | sed 's:/*$::' \
        | grep -E '^[0-9]{8}-[0-9]{6}$' | sort || true)"
  local total
  total="$(printf '%s\n' "$all" | grep -c . || true)"
  if [ "$total" -eq 0 ]; then
    log "Drive retention: no backup folders found at $DRIVE_REMOTE -- nothing to do"
    return 0
  fi
  if [ "$total" -le "$DRIVE_KEEP" ]; then
    log "Drive retention: $total backup(s) on Drive, keeping $DRIVE_KEEP -- nothing to delete"
    return 0
  fi

  local doomed count
  doomed="$(printf '%s\n' "$all" | head -n "$((total - DRIVE_KEEP))")"
  count="$(printf '%s\n' "$doomed" | grep -c . || true)"

  # A correct run removes a handful. Anything wholesale means the listing is
  # not what we think it is, and deleting off-site backups on that basis is
  # not a risk worth taking unattended.
  if [ "$count" -gt 50 ]; then
    log "ERROR: Drive retention wanted to delete $count folders (of $total) -- refusing. Check $DRIVE_REMOTE by hand."
    return 0
  fi

  log "Drive retention: $total backup(s) present, keeping newest $DRIVE_KEEP, removing $count"
  local dir
  while IFS= read -r dir; do
    [ -n "$dir" ] || continue
    if [ "$DRY_RUN" -eq 1 ]; then
      log "  [dry-run] would delete $DRIVE_REMOTE/$dir"
      continue
    fi
    if docker run --rm \
        -v "$RCLONE_CONF":/rclone.conf:ro \
        "$IMAGE" \
        sh -c 'cp /rclone.conf /tmp/rclone.conf && exec rclone --config /tmp/rclone.conf purge "$0/$1"' \
        "$DRIVE_REMOTE" "$dir" >> "$LOG_FILE" 2>&1; then
      log "  deleted $DRIVE_REMOTE/$dir"
    else
      log "  WARNING: could not delete $DRIVE_REMOTE/$dir"
    fi
  done <<< "$doomed"
}

prune_drive

# Report back to the admin panel. Best-effort: the backup itself has already
# happened by now, and failing to write a status file must not fail the run.
if [ "$PRUNE_ONLY" -eq 0 ]; then
  DB_BYTES=0
  [ -f "$DEST/conference.db" ] && DB_BYTES="$(stat -c %s "$DEST/conference.db" 2>/dev/null || echo 0)"
  printf '{"finishedAt":%s,"timestamp":"%s","kind":"%s","uploadedToDrive":%s,"databaseBytes":%s,"requestedBy":"%s"}' \
    "$(date +%s000)" "$TIMESTAMP" "$RUN_KIND" \
    "$([ "$UPLOAD_OK" -eq 1 ] && echo true || echo false)" "$DB_BYTES" "$REQUESTED_BY" \
    | volume_write .backup-status.json || log "WARNING: could not write .backup-status.json"
fi

log "Backup complete."
