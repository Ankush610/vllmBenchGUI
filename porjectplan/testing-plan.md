# Get vllm-bench GUI working on this machine

## Context

The code is **complete** — all 6 milestones from `porjectplan/plan.md` are built (backend, worker, runners, UI, dashboard, SLURM mode, polish). Per `test.md`, what has never happened is a real run on a real Linux+GPU machine. That's the remaining task: not development, just deployment + smoke test.

**Environment audit (already done, read-only):**

| Check | Result |
|---|---|
| GPUs | RTX 5000 Ada 32GB (idle, index 0) + RTX A400 4GB (busy) — preflight passes for TP=1 |
| Driver | 580.142 — supports the CUDA 13.0 container |
| `bin/vllm-bench` | Runs; **all 16 flag names in `app/runners/base.py:bench_args` verified against `--help`** — test.md's "highest-risk assumption" is already cleared |
| `hf` CLI | On PATH (`~/.local/bin/hf`) — downloads work |
| Python | 3.13 (miniconda) — but `fastapi`/`uvicorn` **not installed** |
| `vllm` | **Not on PATH** — but a real container exists: `../vllm/container/vllm-0.24-cuda13.0.sif` (8 GB), and `apptainer` is installed |

So two gaps block a run: missing Python deps, and no `vllm` command.

## Plan

### 1. Create a self-contained conda env with ALL deps
**Principle: everything ships with the project.** The only things assumed from the system are `apptainer` (and `slurm` on the cluster). Container is already in the project dir; `bin/vllm-bench` is bundled.

```bash
conda create -y -n vllm-bench-gui python=3.12
conda run -n vllm-bench-gui pip install -r vllm-bench-gui/requirements.txt
```

Update `requirements.txt` to the **complete** dependency list (not just what's missing), including the HF CLI so downloads never depend on the system `~/.local/bin/hf`:

```
fastapi>=0.110
uvicorn[standard]>=0.29
pydantic>=2.6
httpx>=0.27
huggingface_hub[cli]>=0.23    # provides the `hf` / `huggingface-cli` commands in-env
```

Frontend: no build step and no runtime packages needed — the only external asset is `static/vendor/apexcharts.min.js`; make sure it's downloaded once into the project (run.sh already does this) so the UI never falls back to the CDN. The app is always started from this env (`conda activate vllm-bench-gui`, or `conda run -n vllm-bench-gui`), which puts the env's `hf` first on PATH.

### 2. Provide `vllm` via the Apptainer container (no code changes to the app)
`base.py` builds argv starting `["vllm", "serve", ...]` and resolves it via PATH. Create a wrapper script `vllm-bench-gui/bin/vllm`:

```bash
#!/usr/bin/env bash
# Pin to the RTX 5000 Ada (index 0) — the RTX A400 is display-only, not for compute.
export CUDA_VISIBLE_DEVICES=0
exec apptainer exec --nv /home/admin/Desktop/ankush/LLM-Bench/vLLM-Bench-app/vllm/container/vllm-0.24-cuda13.0.sif vllm "$@"
```

and add one line to `run.sh` to prepend `$PWD/bin` to PATH. Why this works:
- `exec` keeps the wrapper from adding a stray process; apptainer shares the host PID namespace, so `LocalRunner`'s process-group SIGTERM/SIGKILL still reaches the vLLM workers.
- Home dir is auto-bound by apptainer, so the default model dir (`~/.cache/huggingface/hub`) is visible inside the container; `HF_TOKEN` env from `config.hf_env` passes through.

### 3. Smoke test (test.md §1)
Start `./run.sh --port 5173` (web app on **5173** per your request; vLLM server ports stay in the default 8000+ range), then check: UI at `http://127.0.0.1:5173`, `data/` subdirs present, `GET /api/status` GPU list matches nvidia-smi. Sanity-check the wrapper standalone first (`bin/vllm --help` — first container start may be slow).

### 4. Happy-path run (test.md §3)
Queue `Qwen/Qwen2.5-0.5B-Instruct`, dataset `random`, 50 prompts, via the API (curl) and watch in the UI. Verify: lifecycle walks queued → downloading → starting_server → running_benchmark → completed; logs stream per phase; result JSON lands in `data/results/`; dashboard row shows sane numbers — spot-check parsed metrics against the raw JSON (the `services/results.py:_pick` fallbacks are the last untested assumption).

### 5. Server-reuse check (test.md §4, the marquee feature)
Queue a second run, same server config, different concurrency → server must NOT restart (instant `starting_server` with "reusing running server").

### Testing protocol
Before each test step (3, 4, 5), I'll state what I'm about to test and why (e.g. "starting a Qwen 0.5B run to verify the full local pipeline end-to-end") and pause for your input before running it — you may have context (GPU in use, preferred model, etc.) that changes the step.

### Fix policy
Per your instruction: only fix what blocks the happy path (e.g., a wrong flag, a parse key mismatch). Log anything cosmetic/non-blocking in `test.md` instead of chasing it.

### Out of scope
SLURM mode (§7 — no cluster here), the full validation/cancel matrices (§5–6), automated test suite, and anything multi-GPU: **everything runs single-GPU (TP=1) on the RTX 5000 Ada only — the RTX A400 is display-only, not for compute** (the wrapper pins `CUDA_VISIBLE_DEVICES=0` so vLLM never touches it).

## Verification
Steps 3–5 *are* the verification: a completed real benchmark run visible on the dashboard, plus a reused-server second run. Tick off the corresponding checkboxes in `test.md` as they pass.
