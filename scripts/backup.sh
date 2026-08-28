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
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
DEST="$BACKUP_ROOT/$TIMESTAMP"
LOG_FILE="$BACKUP_ROOT/backup.log"

mkdir -p "$DEST"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG_FILE"; }

log "Starting backup -> $DEST"

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
if [ -f "$RCLONE_CONF" ]; then
  if docker run --rm \
    -v "$RCLONE_CONF":/root/.config/rclone/rclone.conf:ro \
    -v "$DEST":/backup:ro \
    "$IMAGE" \
    rclone copy /backup "nqocn-db:NQOCN 2026 Backups/$TIMESTAMP" >> "$LOG_FILE" 2>&1; then
    log "Synced to Google Drive (nqocn-db:NQOCN 2026 Backups/$TIMESTAMP)"
  else
    log "WARNING: Google Drive sync failed -- local backup is still intact"
  fi
else
  log "Skipping Google Drive sync -- $RCLONE_CONF not found"
fi

# Prune backups older than RETENTION_DAYS -- one directory per run, named
# by timestamp, so this only ever touches backup dirs, never the DB/app.
# Google Drive (above) is untouched by this -- it keeps every backup
# indefinitely as the off-site safety net.
find "$BACKUP_ROOT" -maxdepth 1 -type d -name '20*' -mtime "+$RETENTION_DAYS" -print -exec rm -rf {} \; >> "$LOG_FILE" 2>&1

log "Backup complete."
