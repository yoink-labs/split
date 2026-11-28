#!/bin/bash
# Build, guard, migrate and deploy the split-api Worker (API + web bundle).
#
# Cloudflare Workers Builds calls this on every push:
#   main:           bash scripts/deploy-worker.sh deploy
#   other branches: bash scripts/deploy-worker.sh check   (build and dry run only)
#
# Workers Builds provides CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID.
set -euo pipefail
cd "$(dirname "$0")/.."

mode="${1:-}"
if [[ "$mode" != deploy && "$mode" != check ]]; then
  echo "Usage: scripts/deploy-worker.sh deploy|check" >&2
  exit 2
fi

wrangler() { worker/node_modules/.bin/wrangler "$@" --config worker/wrangler.jsonc; }

echo "==> Installing dependencies"
npm ci --prefix worker
npm ci --prefix web

echo "==> Building the web bundle"
npm run build --prefix web

if [[ "$mode" == check ]]; then
  echo "==> Database guard (all migrations)"
  node scripts/check-migrations.mjs --all
  echo "==> Pending remote migrations (read-only; confirms the build token can reach D1)"
  node scripts/check-migrations.mjs --remote
  echo "==> Dry-run deploy (non-production branch: nothing is applied or deployed)"
  wrangler deploy --dry-run --outdir .wrangler/dry-run
  exit 0
fi

echo "==> Database guard (pending remote migrations)"
node scripts/check-migrations.mjs --remote

echo "==> Applying D1 migrations"
wrangler d1 migrations apply split --remote

echo "==> Deploying split-api"
wrangler deploy
