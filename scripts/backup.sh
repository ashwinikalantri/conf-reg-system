#!/usr/bin/env bash
# Nightly backup of the NQOCN 2026 database and file uploads.
#
# Run via cron; safe to run while the app is live. Uses SQLite's Online
# Backup API (`.backup`), not a raw file copy -- a plain `cp` can grab a
# torn/inconsistent snapshot if it runs mid-write, `.backup` can't.
#
# Backups land outside the repo (never something git should touch or a
# `git clean` could sweep up) since they contain delegate PII: phone
# numbers, UTRs, and payment screenshots / ID cards.
set -euo pipefail

APP_DIR="/home/ashwinikalantri/nqocn"
BACKUP_ROOT="/home/ashwinikalantri/nqocn-backups"
RETENTION_DAYS=14
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
DEST="$BACKUP_ROOT/$TIMESTAMP"
LOG_FILE="$BACKUP_ROOT/backup.log"

mkdir -p "$DEST"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG_FILE"; }

log "Starting backup -> $DEST"

# 1. Database. Uses VACUUM INTO (via the app's own Node sqlite3 driver, not
# the system `sqlite3` CLI -- that binary has a broken header/library
# version mismatch on this host and refuses to run at all). VACUUM INTO is
# transactionally consistent, same guarantee as the CLI's `.backup` would
# have given: safe to run while the app is live and writing.
if [ -f "$APP_DIR/conference.db" ]; then
  ( cd "$APP_DIR" && node -e "
    const sqlite3 = require('sqlite3').verbose();
    const db = new sqlite3.Database('conference.db');
    db.run(\"VACUUM INTO '$DEST/conference.db'\", (err) => {
      if (err) { console.error(err.message); process.exit(1); }
      db.close();
    });
  " ) || { log "ERROR: database backup failed"; exit 1; }
  log "Database backed up ($(du -h "$DEST/conference.db" | cut -f1))"
else
  log "WARNING: conference.db not found at $APP_DIR"
fi

# 2. Uploaded files (payment screenshots, ID cards) and imported bank
#    statements -- not stored in the DB, so a DB-only backup would lose them.
for dir in uploads bank-statements; do
  if [ -d "$APP_DIR/$dir" ] && [ -n "$(ls -A "$APP_DIR/$dir" 2>/dev/null)" ]; then
    tar -czf "$DEST/$dir.tar.gz" -C "$APP_DIR" "$dir"
    log "$dir/ archived ($(du -h "$DEST/$dir.tar.gz" | cut -f1))"
  fi
done

# 3. Off-site copy to Google Drive (rclone remote "nqocn-db", set up via
#    `rclone config`). Uses `copy`, not `sync` -- copy only ever adds files,
#    never deletes from the destination, so Drive keeps every night's backup
#    even after local pruning (step 4) removes it here. That way a mistake
#    in the local retention logic (or the server itself failing) can't also
#    wipe the off-site copy. Non-fatal: local backup already succeeded by
#    this point, so a Drive/network hiccup shouldn't fail the whole run.
if command -v rclone >/dev/null 2>&1 && rclone listremotes 2>/dev/null | grep -q '^nqocn-db:$'; then
  if rclone copy "$DEST" "nqocn-db:NQOCN 2026 Backups/$TIMESTAMP" >> "$LOG_FILE" 2>&1; then
    log "Synced to Google Drive (nqocn-db:NQOCN 2026 Backups/$TIMESTAMP)"
  else
    log "WARNING: Google Drive sync failed -- local backup is still intact"
  fi
else
  log "Skipping Google Drive sync -- rclone remote 'nqocn-db' not configured"
fi

# 4. Prune backups older than RETENTION_DAYS -- one directory per run, named
#    by timestamp, so this only ever touches backup dirs, never the DB/app.
#    Google Drive (step 3) is untouched by this -- it keeps every backup
#    indefinitely as the off-site safety net.
find "$BACKUP_ROOT" -maxdepth 1 -type d -name '20*' -mtime "+$RETENTION_DAYS" -print -exec rm -rf {} \; >> "$LOG_FILE" 2>&1

log "Backup complete."
