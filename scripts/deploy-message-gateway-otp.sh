#!/usr/bin/env bash
# Deploy Message Gateway OTP (kills static 1234 stub)
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> Pull latest"
git pull --ff-only

echo "==> Remove ALLOW_STATIC_OTP from .env (if any)"
if [[ -f .env ]]; then
  grep -v '^\s*ALLOW_STATIC_OTP\s*=' .env > .env.tmp || true
  mv .env.tmp .env
  echo "ALLOW_STATIC_OTP removed (static OTP disabled in code)"
fi

echo "==> Restart API"
pm2 restart ashqe-api --update-env || pm2 restart all --update-env
sleep 2

echo "==> OTP status (must be message-gateway)"
curl -sS http://127.0.0.1:3000/api/app/auth/otp-status || true
echo
curl -sS https://ashqe.app/api/app/auth/otp-status || true
echo

echo "==> Send OTP via public URL (must include verificationId, never 1234)"
curl -sS -X POST 'https://ashqe.app/api/app/auth/send-otp' \
  -H 'Content-Type: application/json' \
  -d '{"mobileNumber":"8306690426"}'
echo
echo "Done. If still 1234: pm2 show ashqe-api — wrong cwd or wrong process."
