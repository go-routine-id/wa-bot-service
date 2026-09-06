#!/usr/bin/env bash
# Remote deploy script untuk lane ikavia-dev (pm2-flat). Dijalankan di HOST
# via: ssh <host> <ENV=...> bash -s < scripts/deploy-wa-bot-dev-remote.sh
#
# Service ini STATEFUL: db/, uploads/, dan auth session WhatsApp hidup di
# DEPLOY_DIR dan SENGAJA tidak ikut dibundle dari CI (di-exclude saat tar),
# sehingga ekstrak bundle tidak pernah menimpa data.

set -euo pipefail

WORK_DIR="/tmp/wa-bot-service-dev-deploy"
APP_NAME="${APP_NAME:-wa-bot-service-dev}"
DEPLOY_DIR="${DEPLOY_DIR:-/home/dev/apps/wa-bot-service-dev}"

# node & pm2 hidup di nvm — shell non-interaktif tidak memuatnya sendiri.
[ -f "$HOME/.bashrc" ] && source "$HOME/.bashrc" || true
[ -f "$HOME/.profile" ] && source "$HOME/.profile" || true
[ -f "$HOME/.nvm/nvm.sh" ] && source "$HOME/.nvm/nvm.sh" || true

# ── Runtime Node 22 ─────────────────────────────────────
# better-sqlite3@13 (engines >=22) SIGSEGV di Node 20 — dan pm2 daemon box
# jalan di node 20, jadi interpreter node 22 harus eksplisit (lewat
# WABOT_NODE_BIN → ecosystem.config.js). Idempotent; default alias nvm
# TIDAK diubah — app lain di box tetap di node 20.
nvm install 22 >/dev/null
export WABOT_NODE_BIN="$(nvm which 22)"

# ── Preconditions ────────────────────────────────────────
if [ ! -f "$WORK_DIR/bundle.tgz" ]; then
  echo "✗ Bundle tidak ada di $WORK_DIR setelah scp" >&2
  exit 1
fi
if [ ! -f "$DEPLOY_DIR/.env" ]; then
  echo "✗ $DEPLOY_DIR/.env tidak ditemukan" >&2
  echo "  Buat manual di host (chmod 600) — nilai environment-specific," >&2
  echo "  tidak pernah lewat CI." >&2
  exit 1
fi

# ── Ekstrak source (state tidak ikut bundle) ─────────────
tar xzf "$WORK_DIR/bundle.tgz" -C "$DEPLOY_DIR"

# ── Dependencies ─────────────────────────────────────────
# better-sqlite3 pakai prebuilt binary untuk node20/linux-x64 — tanpa
# toolchain compile. Bila prebuilt gagal unduh, error muncul di sini,
# bukan saat proses start.
cd "$DEPLOY_DIR"
npm ci --omit=dev

# Chromium untuk puppeteer. npm modern memblok postinstall script, jadi
# unduhan browser yang dulu otomatis sekarang harus eksplisit. Idempotent:
# dilewati cepat bila browser versi yang diminta sudah ada di ~/.cache/puppeteer.
npx puppeteer browsers install chrome-headless-shell

# ── (Re)start pm2 ────────────────────────────────────────
# startOrReload (bukan `pm2 restart` polos): baca ulang ecosystem.config.js —
# interpreter WABOT_NODE_BIN ikut terpasang untuk start DAN restart.
pm2 startOrReload ecosystem.config.js --only "$APP_NAME" --update-env
pm2 save

PORT="$(grep -E '^PORT=' "$DEPLOY_DIR/.env" | tail -1 | cut -d= -f2 || true)"
PORT="${PORT:-3000}"

# ── Health gate ──────────────────────────────────────────
# /health sengaja di luar /api (tanpa auth) dan tidak menunggu koneksi
# WhatsApp — deploy perdana boleh sehat sebelum sesi di-scan.
HEALTHY=false
for i in $(seq 1 30); do
  CODE="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT}/health" || true)"
  if [ "$CODE" = "200" ]; then
    echo "✓ /health OK (HTTP 200) setelah ~$((i * 3))s"
    HEALTHY=true
    break
  fi
  sleep 3
done

if [ "$HEALTHY" != "true" ]; then
  echo "✗ Health gate gagal setelah 90s (HTTP terakhir: ${CODE:-none})" >&2
  echo "==> Log 50 baris terakhir pm2:" >&2
  pm2 logs "$APP_NAME" --lines 50 --nostream >&2 || true
  echo "==> Rollback manual: git checkout commit sebelumnya di branch ikavia-dev, push ulang." >&2
  exit 1
fi

rm -rf "$WORK_DIR"
echo "✓ Deploy ${APP_NAME} selesai (sha ${GITHUB_SHA:-?})"
