#!/usr/bin/env bash
# whoof — one-command setup.
# Creates a venv, installs everything, and prints next steps.
set -euo pipefail

cd "$(dirname "$0")"

PYTHON="${PYTHON:-$(command -v python3.13 || command -v python3.12 || command -v python3.11 || command -v python3.10 || command -v python3)}"

if [[ -z "$PYTHON" ]]; then
  echo "ERROR: Python 3.10+ not found. Install with:"
  echo "  brew install python@3.13"
  exit 1
fi

PY_VER=$("$PYTHON" -c 'import sys; print("%d.%d" % sys.version_info[:2])')
echo "Using $PYTHON ($PY_VER)"

if [[ ! -d .venv ]]; then
  "$PYTHON" -m venv .venv
fi

source .venv/bin/activate
pip install --quiet --upgrade pip wheel
pip install --quiet -e ./vendor/whoop-reader
pip install --quiet -e .

echo
echo "Setup complete."
echo
echo "Next steps:"
echo "  1. Grant Terminal Bluetooth access:"
echo "     System Settings → Privacy & Security → Bluetooth → toggle Terminal ON"
echo "  2. Wake the Whoop strap (charge or tap to wake)."
echo "  3. Find it:           ./run.sh scan"
echo "  4. Start recording:   ./run.sh record"
echo "  5. Open dashboard:    ./run.sh dash   →   http://localhost:8765/"
echo
