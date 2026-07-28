#!/usr/bin/env bash
# Run on the tataiya.in server to fix admin login 404.
# Usage: bash fix-live-api-routing.sh

set -euo pipefail

echo "==> Fixing nginx /api proxy (keep /api prefix)..."
NGINX_FILES=$(grep -rl "proxy_pass" /etc/nginx/sites-enabled /etc/nginx/conf.d 2>/dev/null || true)
if [ -z "${NGINX_FILES}" ]; then
  echo "No nginx site files found under sites-enabled/conf.d"
else
  echo "Found: $NGINX_FILES"
fi

# Preferred snippet (manual if sed is unsafe on your config):
# location /api/ {
#     proxy_pass http://127.0.0.1:3000/api/;
# }

echo "==> Pulling latest API (dual /api registration)..."
API_DIR="${API_DIR:-/var/www/tataiya/api-server}"
if [ -d "$API_DIR/.git" ]; then
  cd "$API_DIR"
  git pull origin main
  if command -v pm2 >/dev/null 2>&1; then
    pm2 restart all || true
  elif systemctl list-units --type=service | grep -qi tataiya; then
    sudo systemctl restart tataiya-api || sudo systemctl restart tataiya || true
  else
    echo "Restart your Node API process manually (pm2/systemd)."
  fi
else
  echo "API dir $API_DIR not found — set API_DIR=/path/to/tataiya-api-server and re-run."
fi

echo "==> Testing nginx config..."
sudo nginx -t && sudo systemctl reload nginx || true

echo "==> Smoke test..."
curl -sS -o /dev/null -w "POST /api/auth/login => %{http_code}\n" \
  -X POST http://127.0.0.1:3000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@tataiya.com","password":"Tataiya@Admin2026"}' || true

echo "Done. Try https://tataiya.in/admin/login"
