#!/usr/bin/env bash
# One-shot setup: recreate this project's environment on any Linux machine.
#
#   ./setup.sh          # create/refresh the conda env, deps, .env, vendor file
#
# Assumed present on the system (everything else ships with the project):
#   - conda      (to build the env)
#   - apptainer  (to run the vLLM container)
#   - nvidia-smi (GPU host with drivers)
#   - SLURM      (only for execution_mode=slurm, on a cluster)
#
# Safe to re-run: it is idempotent and never overwrites an existing .env.
set -euo pipefail
cd "$(dirname "$0")"

PYTHON_VERSION="${PYTHON_VERSION:-3.12}"
ok()   { printf '  \033[32mok\033[0m   %s\n' "$1"; }
warn() { printf '  \033[33mwarn\033[0m %s\n' "$1"; }
die()  { printf '  \033[31mfail\033[0m %s\n' "$1" >&2; exit 1; }

echo "==> Checking system prerequisites"
command -v conda >/dev/null 2>&1 || die "conda not found — install Miniconda first"
ok "conda: $(conda --version)"
if command -v apptainer >/dev/null 2>&1; then ok "apptainer: $(apptainer --version)"
else warn "apptainer not found — needed to run vLLM (bin/vllm)"; fi
if command -v nvidia-smi >/dev/null 2>&1; then
  ok "GPUs: $(nvidia-smi --query-gpu=name --format=csv,noheader | paste -sd', ')"
else warn "nvidia-smi not found — runs will fail preflight"; fi

echo "==> Conda env"
ENV_NAME="${CONDA_ENV_NAME:-vllm-bench-gui}"
CONDA_BASE="$(conda info --base)"
ENV_PATH="$CONDA_BASE/envs/$ENV_NAME"
if [[ -x "$ENV_PATH/bin/python" ]]; then
  ok "env '$ENV_NAME' exists ($("$ENV_PATH/bin/python" --version 2>&1))"
else
  echo "  creating '$ENV_NAME' (python $PYTHON_VERSION)…"
  conda create -y -n "$ENV_NAME" "python=$PYTHON_VERSION" >/dev/null
  ok "env created"
fi

echo "==> Python deps"
# Always the env's own interpreter: a bare `pip` can resolve to a system pip
# that installs into the wrong Python entirely.
"$ENV_PATH/bin/python" -m pip install -q --upgrade pip >/dev/null
"$ENV_PATH/bin/python" -m pip install -q -r requirements.txt
"$ENV_PATH/bin/python" - <<'PY'
import fastapi, uvicorn, pydantic, httpx, huggingface_hub, sys
print(f"  ok   deps in {sys.prefix}")
print(f"       fastapi {fastapi.__version__} · uvicorn {uvicorn.__version__} · "
      f"pydantic {pydantic.VERSION} · httpx {httpx.__version__} · hub {huggingface_hub.__version__}")
PY
[[ -x "$ENV_PATH/bin/hf" ]] && ok "hf CLI: $ENV_PATH/bin/hf" || warn "hf CLI missing from env"

echo "==> Container image"
SIF=""
if compgen -G "../vllm/container/*.sif" >/dev/null; then
  # Largest .sif wins — the repo also carries a 0-byte placeholder.
  SIF="$(du -b ../vllm/container/*.sif 2>/dev/null | sort -rn | head -1 | cut -f2-)"
  SIF="$(cd "$(dirname "$SIF")" && pwd)/$(basename "$SIF")"
  [[ -s "$SIF" ]] && ok "found $(basename "$SIF") ($(du -h "$SIF" | cut -f1))" || { warn "only an empty .sif found"; SIF=""; }
else
  warn "no .sif under ../vllm/container — set VLLM_SIF in .env by hand"
fi

echo "==> .env"
if [[ -f .env ]]; then
  ok ".env exists — leaving it untouched"
else
  cp .env.example .env
  # Fill in what we detected; the rest keeps the template's defaults.
  sed -i "s|^CONDA_ENV_NAME=.*|CONDA_ENV_NAME=$ENV_NAME|" .env
  sed -i "s|^CONDA_ENV_PATH=.*|CONDA_ENV_PATH=$ENV_PATH|" .env
  [[ -n "$SIF" ]] && sed -i "s|^VLLM_SIF=.*|VLLM_SIF=$SIF|" .env
  ok ".env written from .env.example (review the GPU indices!)"
fi

echo "==> Static assets & binaries"
chmod +x run.sh bin/vllm bin/vllm-bench 2>/dev/null || true
ok "exec bits set on run.sh, bin/vllm, bin/vllm-bench"
if [[ -f static/vendor/apexcharts.min.js ]]; then
  ok "apexcharts vendored ($(du -h static/vendor/apexcharts.min.js | cut -f1))"
else
  echo "  fetching apexcharts…"
  if curl -fsSL -o static/vendor/apexcharts.min.js \
      https://cdn.jsdelivr.net/npm/apexcharts@3.49.1/dist/apexcharts.min.js 2>/dev/null; then
    ok "apexcharts vendored"
  else
    warn "could not fetch apexcharts — charts will use the CDN (needs internet)"
  fi
fi

echo
echo "Setup complete. Review .env (GPU indices especially), then:"
echo "    ./run.sh"
