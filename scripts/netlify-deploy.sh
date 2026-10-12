#!/usr/bin/env bash
# Deploy the SPA to Netlify, with /api, /auth and /health proxied to the same origin.
#
# Requires NETLIFY_AUTH_TOKEN in the environment (Netlify -> User settings -> Applications
# -> Personal access tokens). The token is never written anywhere by this script.
#
#   NETLIFY_AUTH_TOKEN=... bash scripts/netlify-deploy.sh
set -euo pipefail
cd "$(dirname "$0")/.."

: "${NETLIFY_AUTH_TOKEN:?NETLIFY_AUTH_TOKEN is required}"
SITE_NAME="${SITE_NAME:-inicio-survey}"
BASE="https://api.netlify.com/api/v1"
AUTH=(-H "Authorization: Bearer $NETLIFY_AUTH_TOKEN")

echo "== build =="
pnpm --filter @inicio/web build >/dev/null
(cd apps/web/dist && rm -f /tmp/inicio-site.zip && zip -qr /tmp/inicio-site.zip .)
echo "   $(du -h /tmp/inicio-site.zip | cut -f1) archive from apps/web/dist"

echo "== site =="
SITE_ID=$(curl -s "${AUTH[@]}" "$BASE/sites" | jq -r --arg n "$SITE_NAME" '.[] | select(.name==$n) | .id' | head -1)
if [ -z "$SITE_ID" ] || [ "$SITE_ID" = "null" ]; then
  SITE_ID=$(curl -s "${AUTH[@]}" -X POST "$BASE/sites" \
    -H "Content-Type: application/json" -d "{\"name\":\"$SITE_NAME\"}" | jq -r '.id')
fi
echo "   site $SITE_ID"

echo "== deploy =="
DEPLOY=$(curl -s "${AUTH[@]}" -X POST "$BASE/sites/$SITE_ID/deploys" \
  -H "Content-Type: application/zip" --data-binary @/tmp/inicio-site.zip)
DEPLOY_ID=$(printf '%s' "$DEPLOY" | jq -r '.id')
echo "   deploy $DEPLOY_ID"

for _ in $(seq 1 40); do
  STATE=$(curl -s "${AUTH[@]}" "$BASE/sites/$SITE_ID/deploys/$DEPLOY_ID" | jq -r '.state')
  [ "$STATE" = "ready" ] && break
  [ "$STATE" = "error" ] && { echo "   deploy failed"; exit 1; }
  sleep 5
done

URL=$(curl -s "${AUTH[@]}" "$BASE/sites/$SITE_ID/deploys/$DEPLOY_ID" | jq -r '.ssl_url // .url')
echo "   state $STATE"
echo "   live: $URL"
