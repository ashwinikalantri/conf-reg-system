#!/usr/bin/env bash
# Presenters' files, copied to Google Drive (owner, 17 Nov 2026).
#
# Every file a presenter uploads (or staff upload for them) lands flat in
# uploads/presentations as <reg no>_<name>_<Oral|Poster|Award>.pdf. This
# mirrors them into the Drive the nightly backups use, one folder per format:
#
#   NQOCN 2026 Presentations/Oral/   NQOCN20260045_Asha_Patil_Oral.pdf ...
#                           /Poster/<session>/<screen>/
#                           /Award/
#
# E-posters go by poster session and screen (owner, 20 Nov 2026), as the app
# lays them out in .presentations-drive-layout.json beside the database;
# scripts/presentations-drive-stage.js builds the tree. A poster moved to
# another screen is moved on Drive (rclone --track-renames), not uploaded
# again and not binned.
#
# Same arrangement as scripts/backup.sh, for the same reason: the Drive
# credential (the rclone remote "nqocn-db") never enters the web-facing app
# container. rclone runs in a short-lived container off the app image, with
# the config and the presentations folder mounted read-only -- it sees
# nothing else of the data volume.
#
# Run by cron every minute; does nothing unless a file has been added,
# replaced or removed since the last good copy, or "Copy to Drive now" in
# Step 3 asked for one. A file replaced here is replaced on Drive (same name,
# new content); one removed or renamed here goes to Drive's bin, at most
# MAX_DELETE in one run, so an empty or missing folder can never wipe Drive.
# Files someone adds to the Drive folders by hand are left alone unless they
# follow the same naming pattern.
#
# Reports to the panel through two files beside the database:
# .presentations-drive-status.json, the last good copy (when, the folder
# links, and what is on Drive: names and sizes only), and
# .presentations-drive-error.json, while the latest attempt has failed.
set -euo pipefail
export PATH="/usr/local/bin:/usr/bin:/bin:$PATH"

DATA_VOLUME="nqocn_data"
IMAGE="nqocn-app"
RCLONE_CONF="/root/.config/rclone/rclone.conf"
DRIVE_ROOT="nqocn-db:"
FOLDER="${PRESENTATIONS_DRIVE_FOLDER:-NQOCN 2026 Presentations}"
TYPES="Oral Poster Award"
MAX_DELETE=20
STATE_DIR="${PRESENTATIONS_DRIVE_STATE:-/home/ashwinikalantri/nqocn-backups}"
LOG_FILE="$STATE_DIR/presentations-drive.log"
LAST_FILE="$STATE_DIR/.presentations-drive.last"

mkdir -p "$STATE_DIR"
log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG_FILE"; }

# One run at a time: a large first copy can take longer than a minute.
exec 9>"$STATE_DIR/.presentations-drive.lock"
flock -n 9 || exit 0

MOUNT="$(docker volume inspect -f '{{.Mountpoint}}' "$DATA_VOLUME" 2>/dev/null || true)"
# The two overrides are for a trial run against a scratch folder.
SRC="${PRESENTATIONS_DRIVE_SRC:-$MOUNT/uploads/presentations}"
REPORT_DIR="${PRESENTATIONS_DRIVE_REPORT:-$MOUNT}"
REQUEST="$REPORT_DIR/.presentations-drive-request.json"
LAYOUT="$REPORT_DIR/.presentations-drive-layout.json"
STAGER="$(dirname "$(readlink -f "$0")")/presentations-drive-stage.js"
STATUS="$REPORT_DIR/.presentations-drive-status.json"
FAILED="$REPORT_DIR/.presentations-drive-error.json"
[ -n "$MOUNT" ] && [ -d "$SRC" ] || exit 0

# What is there now: names, sizes and times of the finished files (a file
# still being written is a dot-file, and is not counted).
# A new layout (a poster moved to another screen) counts as a change.
FINGERPRINT="$( { find "$SRC" -maxdepth 1 -type f -name '*.pdf' ! -name '.*' -printf '%f %s %T@\n' | sort; cat "$LAYOUT" 2>/dev/null; } | md5sum | cut -d' ' -f1)"
if [ ! -f "$REQUEST" ] && [ -f "$LAST_FILE" ] && [ "$(cat "$LAST_FILE")" = "$FINGERPRINT" ]; then
  exit 0
fi

# Written whole, then moved into place, so the panel never reads half a file.
put() { cat > "$1.tmp" && mv -f "$1.tmp" "$1"; }

if [ ! -f "$RCLONE_CONF" ]; then
  printf '{"at":%s,"error":"Google Drive is not linked on the server."}' "$(date +%s000)" | put "$FAILED"
  rm -f "$REQUEST"
  exit 1
fi

LAYOUT_MOUNT="$LAYOUT"
[ -f "$LAYOUT" ] || LAYOUT_MOUNT=/dev/null

# The copy, in one pass: each file is staged (as a link) in its folder, then the staging tree is mirrored to Drive -- one listing per
# folder, rather than a pass per format. The include rules keep the mirror
# to the files this makes, so anything else in the Drive folder is left
# alone. Then the folder links for the panel. Few calls to Google on
# purpose: the remote uses rclone's shared sign-in, which Google throttles.
# The working copy of the config is because rclone writes a refreshed token
# back to it.
if OUT="$(docker run --rm \
    -v "$RCLONE_CONF":/rclone.conf:ro \
    -v "$SRC":/src:ro \
    -v "$LAYOUT_MOUNT":/layout.json:ro \
    -v "$STAGER":/stage.js:ro \
    "$IMAGE" \
    sh -c '
      set -e
      cp /rclone.conf /tmp/r.conf
      R="rclone --config /tmp/r.conf"
      set --  "$0" "$1" "$2" "$3"
      node /stage.js /src /layout.json /tmp/stage "$3"
      set -f
      for t in $3; do INCLUDE="$INCLUDE --include /$t/**_$t.pdf"; done
      fail() { tail -c 400 /tmp/err >&2; exit 1; }
      $R sync /tmp/stage "$1$2" --copy-links --create-empty-src-dirs --track-renames $INCLUDE --max-delete "$4" 2>/tmp/err || fail
      $R lsjson --dirs-only --no-modtime --no-mimetype "$1" > /tmp/root.json 2>>/tmp/err || fail
      $R lsjson --dirs-only --no-modtime --no-mimetype "$1$2" > /tmp/sub.json 2>>/tmp/err || fail
      node -e "
        const fs = require(\"fs\");
        const [folder, types] = process.argv.slice(1);
        const top = JSON.parse(fs.readFileSync(\"/tmp/root.json\", \"utf8\")).find((d) => d.Name === folder) || {};
        const folders = Object.fromEntries(JSON.parse(fs.readFileSync(\"/tmp/sub.json\", \"utf8\")).map((d) => [d.Name, d.ID]));
        const walk = (rel) => fs.readdirSync(\"/tmp/stage/\" + rel, { withFileTypes: true }).flatMap((e) => (e.isDirectory()
          ? walk(rel + \"/\" + e.name) : [{ path: rel + \"/\" + e.name, size: fs.statSync(\"/tmp/stage/\" + rel + \"/\" + e.name).size }]));
        const files = types.split(\" \").flatMap((t) => walk(t));
        process.stdout.write(JSON.stringify({ checkedAt: Date.now(), folder, folderId: top.ID || null, folders, files }));
      " "$2" "$3"
    ' "$DRIVE_ROOT" "$FOLDER" "$TYPES" "$MAX_DELETE" 2>&1)"; then
  printf '%s' "$OUT" | put "$STATUS"
  rm -f "$FAILED"
  printf '%s' "$FINGERPRINT" > "$LAST_FILE"
  log "Copied to Drive ($(printf '%s' "$OUT" | grep -o '"path"' | wc -l) files there)."
else
  ERR="$(printf '%s' "$OUT" | tr -d '"\\' | tr '\n' ' ' | tail -c 300)"
  printf '{"at":%s,"error":"%s"}' "$(date +%s000)" "$ERR" | put "$FAILED"
  log "Copy to Drive failed: $ERR"
fi
rm -f "$REQUEST"
