# vllm-bench GUI

A simple single-node web GUI for running [vllm-bench](https://github.com/vllm-project/vllm-bench)
benchmarks: queue models, auto-download from Hugging Face, auto-serve with
vLLM, benchmark, and visualize results. Runs locally on a workstation or on a
PARAM Shavak-style node with optional SLURM execution.

**Design principle:** simplicity over completeness. Only the parameters that
matter are exposed; everything else is hardcoded to sane defaults. Execution
is strictly serial — one run at a time.

## Requirements

The project is self-contained: Python deps live in its own conda env, vLLM runs
from the bundled Apptainer image, and `bin/vllm-bench` ships with the repo.
Only these are assumed from the host:

- Linux with NVIDIA GPU(s) and `nvidia-smi`
- `conda` (to build the env) and `apptainer` (to run the vLLM container)
- For SLURM mode: `sbatch`, `squeue`, `sacct`, `scancel` on PATH and a shared
  filesystem between this machine and the compute nodes

Nothing else is taken from the system — no system Python packages, no
system-wide vLLM, no CDN at runtime.

## Quick start

```bash
cd vllm-bench-gui
./setup.sh               # conda env + deps + .env + vendored assets (idempotent)
$EDITOR .env             # check GPU indices and paths for this machine
./run.sh                 # http://127.0.0.1:5173
# or expose on the LAN (no auth in v1 — deliberate choice, be careful):
./run.sh --host 0.0.0.0 --port 5173
```

Open the UI, go to **Settings** to check the model dir / HF token, then queue
runs from the **Benchmark** view and watch results appear on the **Dashboard**.

## Moving to another machine

`.env` is the only file that knows about the current machine — run `./setup.sh`
(it writes `.env` from `.env.example`, auto-detecting the conda env path and the
`.sif` image), then review it. It holds no secrets; the HF token lives in the
app DB via the Settings page.

| Variable | Meaning |
|---|---|
| `HOST` / `PORT` | Where the GUI listens (default `127.0.0.1:5173`) |
| `CONDA_ENV_NAME` / `CONDA_ENV_PATH` | The env holding every Python dep; `run.sh` uses its interpreter directly, so no `conda activate` is needed |
| `VLLM_SIF` | Apptainer image providing the `vllm` command |
| `CUDA_VISIBLE_DEVICES` | GPU indices vLLM may use (`nvidia-smi -L` to list) |
| `CUDA_DEVICE_ORDER` | Kept at `PCI_BUS_ID` so CUDA numbers GPUs like `nvidia-smi` does — matters when the cards differ |

There is no native vLLM install: `bin/vllm` is a small shim that `run.sh` puts
first on PATH, so the runners' `vllm serve …` argv (see
`app/runners/base.py`) transparently executes inside the container.

## How a run executes

```
queued → downloading → starting_server → running_benchmark → completed
                └───────────┴───────────────┴────→ failed / cancelled
```

1. **Preflight** — vllm-bench binary present, GPUs free, disk space if a
   download is needed.
2. **Download** — if the model is not in the model dir, `hf download` runs
   locally (even in SLURM mode; compute nodes have no internet). Downloads
   resume, so a cancelled download is never wasted.
3. **Serve** — `vllm serve` is started on the next free port; `/health` is
   polled until ready (default timeout 600 s, configurable in Settings).
4. **Benchmark** — `vllm-bench` runs with the assembled flags; the raw result
   JSON is kept in `data/results/<run_id>.json`.
5. **Server reuse** — if the next queued run has an identical server config
   (model, TP size, GPU mem util, max len, extra args), the server is kept
   alive and only the benchmark re-runs. This makes manual concurrency sweeps
   fast: clone a tab with "+", change concurrency, submit.

In SLURM mode each run becomes one self-contained `sbatch` job (server +
health check + benchmark on the same compute node); generated scripts are
kept in `data/slurm/` for debugging.

## The four views

- **Benchmark** — run tabs ("+" clones the current tab), server + benchmark
  parameter grid with tooltips and inline validation, live log tail
  (download / server / bench phases), status chip, footer with model dir,
  HF-token indicator and live vLLM server status. Picking a dataset swaps in
  that dataset's own options (schema-driven from `GET /api/datasets`), with
  a badge showing its network needs.
- **Datasets** — catalog of the built-in datasets (`random`, `sonnet`,
  `sharegpt`, `speed-bench`, `hf`) with their flags and network badges,
  the local `.json`/`.jsonl` files scanned from the dataset dir (fixed at
  `data/datasets/`), and the **offline mode** toggle: when on, `hf` requires
  subset + split (that's what makes a warm cache work without egress) and
  datasets that would download show a nudge to set a local path.
- **Dashboard** — six charts in a 3×2 grid (left column throughput: output
  tok/s, req/s, total tok/s; right column latency: TTFT p50/p99, TPOT
  p50/p99, E2EL p99). Each chart has a Bar/Line toggle, an expand modal, and
  zoom/pan in line mode. Below, the results table with select-all (charts
  follow the selection), sorting, per-run delete, and CSV export.
- **Settings** — dirs, HF token (write-only; UI only shows whether one is
  loaded), port range, bind address, execution mode, and the SLURM block
  (partition, GPUs, time limit, account, extra flags).

## Data layout

```
data/
├── app.db                 # SQLite: runs, parsed results, settings
├── logs/<run_id>/         # download.log, server.log, bench.log, slurm-<job>.out
├── results/<run_id>.json  # raw vllm-bench output (kept for re-parse/export)
├── slurm/<run_id>.sbatch  # generated job scripts (SLURM mode)
└── datasets/              # default dataset dir (drop .json/.jsonl here)
```

Everything under `data/` is runtime state and gitignored. The frontend holds
zero authoritative state — a page refresh re-hydrates from the backend, and
unsubmitted draft tabs survive via localStorage.

## API summary

| Method & path | Purpose |
|---|---|
| `POST /api/runs` | Queue one or more run configs |
| `GET /api/runs` | All runs with statuses |
| `POST /api/runs/{id}/cancel` | Cancel a queued/active run |
| `POST /api/runs/cancel-all` | Cancel active + clear queue |
| `DELETE /api/runs/{id}` | Delete run + result JSON + logs |
| `GET /api/runs/{id}/logs?file=auto&offset=N` | Byte-offset log tail |
| `GET /api/models` | Local models scanned from the model dir |
| `GET /api/datasets` | Dataset schema (fields/badges) + scanned dataset files |
| `GET /api/dashboard/results` | Parsed metrics for table + charts |
| `GET /api/dashboard/export?ids=…` | CSV of selected runs |
| `GET/PUT /api/settings` | Read/save settings |
| `GET /api/status` | Worker state, active server, GPU snapshot |

## Troubleshooting

- **Run fails at preflight** — the status detail says why: missing binary,
  busy GPUs, or low disk. Fix and re-submit; the queue continues past a
  failed run automatically.
- **Health check timeout** — large models can take a while to load; raise
  the timeout in Settings. Check `data/logs/<run_id>/server.log` for OOM
  (lower *GPU memory utilization* or *Max model len*).
- **Charts empty / "ApexCharts not available"** — offline machine without
  the vendor file. See `static/vendor/README.md`.
- **Backend restarted mid-run** — local runs are marked
  `failed (interrupted)`; surviving SLURM jobs are re-adopted and keep
  reporting status.

## Out of scope for v1

Sweeps (queue tabs manually instead), multi-turn chat datasets, LoRA,
embeddings/pooling, profiling, authentication, WebSockets (polling only).
