#!/bin/bash
set -euo pipefail
npm ci --prefix worker
npm run typecheck --prefix worker
npm test --prefix worker
xcodegen generate
"${ADE_CLI_PATH:-ade}" apple test --scheme Split --text
