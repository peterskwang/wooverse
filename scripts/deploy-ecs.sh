#!/usr/bin/env bash
set -Eeuo pipefail

# This script runs on ECS via Aliyun RunCommand.
# The caller must base64-encode the full script content and invoke RunCommand
# with --ContentEncoding Base64.

WORKDIR="${ALIYUN_RUNCOMMAND_WORKDIR:-/opt/wooverse}"
RELEASES_DIR="$WORKDIR/releases"
CURRENT_LINK="$WORKDIR/current"

TIMESTAMP="${DEPLOY_TIMESTAMP:-$(date -u +%Y%m%d%H%M%S)}"
RELEASE_DIR="$RELEASES_DIR/$TIMESTAMP"
RELEASE_ARCHIVE="${RELEASE_ARCHIVE:-$WORKDIR/incoming/wooverse-release.tgz}"

PREVIOUS_RELEASE="$(readlink -f "$CURRENT_LINK" 2>/dev/null || true)"

rollback_link() {
  if [ -n "$PREVIOUS_RELEASE" ] && [ -d "$PREVIOUS_RELEASE" ]; then
    ln -sfn "$PREVIOUS_RELEASE" "$CURRENT_LINK"
  fi
}

cleanup_failed_release() {
  rm -rf "$RELEASE_DIR"
}

on_error() {
  echo "[deploy] failed, restoring previous symlink if possible" >&2
  rollback_link
  cleanup_failed_release
}
trap on_error ERR

mkdir -p "$RELEASES_DIR" "$WORKDIR/incoming"

if [ ! -f "$RELEASE_ARCHIVE" ]; then
  echo "[deploy] release archive not found: $RELEASE_ARCHIVE" >&2
  exit 1
fi

echo "[deploy] extracting release to $RELEASE_DIR"
mkdir -p "$RELEASE_DIR"
tar -xzf "$RELEASE_ARCHIVE" -C "$RELEASE_DIR"

echo "[deploy] updating current symlink -> $RELEASE_DIR"
ln -sfn "$RELEASE_DIR" "$CURRENT_LINK"

echo "[deploy] backend npm ci/build/migrate"
cd "$CURRENT_LINK/backend"
npm ci
npm run build --if-present
npm run migrate

echo "[deploy] admin npm ci/build"
cd "$CURRENT_LINK/admin"
npm ci
npm run build

echo "[deploy] restarting PM2 apps"
pm2 restart wooverse-backend --update-env
pm2 restart wooverse-admin --update-env

echo "[deploy] backend health check"
curl -fsS http://127.0.0.1:8102/health >/dev/null

echo "[deploy] admin health check"
curl -fsS http://127.0.0.1:8101/ >/dev/null

echo "[deploy] keeping only the latest 3 releases"
if [ -d "$RELEASES_DIR" ]; then
  ls -1dt "$RELEASES_DIR"/* 2>/dev/null | tail -n +4 | xargs -r rm -rf
fi

echo "[deploy] release $TIMESTAMP complete"
