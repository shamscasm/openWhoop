#!/usr/bin/env bash
# Thin wrapper: activate the venv and forward to the whoof CLI.
set -euo pipefail
cd "$(dirname "$0")"
if [[ ! -d .venv ]]; then
  echo "Run ./setup.sh first."
  exit 1
fi
exec .venv/bin/whoof "$@"
