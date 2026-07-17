#!/usr/bin/env bash
# vllm-bench GUI launcher.
# Usage: ./run.sh [--host 0.0.0.0] [--port 5173]
#
# Machine-specific paths, ports and GPU pins live in .env — edit that file when
# moving to a new machine, not this script. CLI flags override .env.
set -euo pipefail
cd "$(dirname "$0")"

# .env is the source of truth for this machine; `set -a` exports every value so
# subprocesses (bin/vllm, hf) inherit them.
if [[ -f .env ]]; then
  set -a; source .env; set +a
else
  echo "warning: no .env found; falling back to built-in defaults" >&2
fi

HOST="${HOST:-127.0.0.1}"
PORT="${PORT:-5173}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --host) HOST="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    *) echo "unknown arg: $1"; exit 1 ;;
  esac
done

if [[ ! -x bin/vllm-bench ]]; then
  chmod +x bin/vllm-bench 2>/dev/null || true
fi

# bin/ first so `vllm` resolves to our container shim; the conda env's bin next
# so `hf` comes from our env rather than any system-wide install.
export PATH="$PWD/bin:${CONDA_ENV_PATH:+$CONDA_ENV_PATH/bin:}$PATH"

# Run with the env's own interpreter — no `conda activate` needed, and no
# chance of picking up a system uvicorn.
PY="${CONDA_ENV_PATH:+$CONDA_ENV_PATH/bin/python}"
if [[ -z "$PY" || ! -x "$PY" ]]; then
  echo "error: python not found at '${PY:-<CONDA_ENV_PATH unset>}'." >&2
  echo "Set CONDA_ENV_PATH in .env, or create the env:" >&2
  echo "  conda create -y -n vllm-bench-gui python=3.12" >&2
  echo "  \"\$(conda info --base)\"/envs/vllm-bench-gui/bin/python -m pip install -r requirements.txt" >&2
  exit 1
fi
if ! "$PY" -c "import fastapi, uvicorn" 2>/dev/null; then
  echo "error: deps missing in $CONDA_ENV_PATH — run:" >&2
  echo "  $PY -m pip install -r requirements.txt" >&2
  exit 1
fi

# Fetch ApexCharts vendor file if missing and we are online (optional; the
# frontend falls back to the CDN automatically when this file is absent).
if [[ ! -f static/vendor/apexcharts.min.js ]]; then
  curl -fsSL -o static/vendor/apexcharts.min.js \
    https://cdn.jsdelivr.net/npm/apexcharts@3.49.1/dist/apexcharts.min.js \
    2>/dev/null || echo "note: could not fetch apexcharts vendor file; UI will use CDN fallback"
fi

exec "$PY" -m uvicorn app.main:app --host "$HOST" --port "$PORT"
