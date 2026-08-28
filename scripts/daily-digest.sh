#!/usr/bin/env bash
# Wrapper for cron: runs the daily registration-summary email and logs the
# outcome. See scripts/backup.sh for why PATH is set explicitly -- cron's
# minimal default PATH doesn't include /usr/local/bin (and, here, not
# /usr/bin/docker's compose plugin path either).
set -euo pipefail
export PATH="/usr/local/bin:/usr/bin:/bin:$PATH"

APP_DIR="/home/ashwinikalantri/nqocn"
LOG_FILE="/home/ashwinikalantri/nqocn-backups/daily-digest.log"

mkdir -p "$(dirname "$LOG_FILE")"

# Runs inside the app container rather than on the host, so the digest uses
# the same Node the app does -- daily-digest.js imports the AWS SES SDK,
# which declares engines >=20, and the host's Node is older than that. The
# container also already has .env/conference.db symlinked onto the /data
# volume, so no host paths need to be threaded through.
#
# -T disables TTY allocation: cron has no terminal, and without it docker
# refuses to run ("the input device is not a TTY").
#
# `docker compose exec` needs the compose project, so this cd's to APP_DIR
# (where docker-compose.yml lives) rather than relying on the cron cwd.
{
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Starting daily digest"
  if ! docker compose -f "$APP_DIR/docker-compose.yml" --project-directory "$APP_DIR" ps --status running --quiet app | grep -q .; then
    # Fail loudly rather than silently skipping a day's digest: if the app
    # container is down, that is itself worth seeing in this log.
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] ERROR: app container is not running; digest skipped"
  elif docker compose -f "$APP_DIR/docker-compose.yml" --project-directory "$APP_DIR" exec -T app node scripts/daily-digest.js; then
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Daily digest complete"
  else
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] ERROR: daily digest failed"
  fi
} >> "$LOG_FILE" 2>&1
