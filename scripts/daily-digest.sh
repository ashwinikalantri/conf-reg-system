#!/usr/bin/env bash
# Wrapper for cron: runs the daily registration-summary email and logs the
# outcome. See scripts/backup.sh for why PATH is set explicitly -- cron's
# minimal default PATH doesn't include /usr/local/bin.
set -euo pipefail
export PATH="/usr/local/bin:/usr/bin:/bin:$PATH"

APP_DIR="/home/ashwinikalantri/nqocn"
LOG_FILE="/home/ashwinikalantri/nqocn-backups/daily-digest.log"

mkdir -p "$(dirname "$LOG_FILE")"

{
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Starting daily digest"
  if node "$APP_DIR/scripts/daily-digest.js"; then
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Daily digest complete"
  else
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] ERROR: daily digest failed"
  fi
} >> "$LOG_FILE" 2>&1
