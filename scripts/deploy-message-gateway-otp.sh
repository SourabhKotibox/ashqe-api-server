#!/usr/bin/env bash
# Build + start ashqe-api with Message Gateway OTP (no static 1234)
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> Pull"
git pull --ff-only

echo "==> Remove ALLOW_STATIC_OTP from .env"
if [[ -f .env ]]; then
  grep -v '^\s*ALLOW_STATIC_OTP\s*=' .env > .env.tmp || true
  mv .env.tmp .env
fi

echo "==> Build (creates dist/index.mjs)"
npm run build

echo "==> Stop old process"
pm2 delete ashqe-api 2>/dev/null || true

echo "==> Start: node dist/index.mjs on PORT 3000"
# Prefer production start (built bundle). NODE_ENV=production.
PORT="${PORT:-3000}" NODE_ENV=production \
  pm2 start dist/index.mjs \
  --name ashqe-api \
  --update-env \
  --cwd "$(pwd)"

pm2 save --force
sleep 2
pm2 status

echo ""
echo "==> Local otp-status"
curl -sS "http://127.0.0.1:${PORT:-3000}/api/app/auth/otp-status" || true
echo ""
echo "==> Public send-otp (must have verificationId)"
curl -sS -X POST 'https://ashqe.app/api/app/auth/send-otp' \
  -H 'Content-Type: application/json' \
  -d '{"mobileNumber":"8306690426"}'
echo ""
echo "Done."
