# CLAUDE.md — vllm-bench GUI

Guidance for AI assistants (and new contributors) working in this repo.

## What this is

A FastAPI + vanilla-JS web GUI around the `vllm-bench` Rust binary
(`bin/vllm-bench`): queue benchmark runs, auto-download models, auto-serve
with vLLM, and chart results. Full spec lives in
`../porjectplan/plan.md` — read it before making design changes; the code
intentionally follows it section by section.

## Architecture in one paragraph

`app/main.py` mounts the API routers and `static/`, and on startup runs
`startup_reconciliation()` then starts the singleton `QueueWorker`
(`app/queue_worker.py`) — a single asyncio task that executes runs strictly
serially through the lifecycle `queued → downloading → starting_server →
running_benchmark → completed/failed/cancelled`. Blocking subprocess work is
pushed to threads with `asyncio.to_thread`. `runners/local_runner.py` owns
process groups, port allocation and server reuse; `runners/slurm_runner.py`
generates one self-contained sbatch job per run and polls `squeue`/`sacct`.
State lives in SQLite (`app/db.py`, one short-lived connection per call, WAL)
plus flat files under `data/` (logs, raw result JSONs, sbatch scripts). The
frontend (`static/js/*.js`, no build step) holds zero authoritative state and
re-hydrates from the API on refresh; draft tabs mirror to localStorage.

## Conventions and invariants

- **One run at a time.** Never parallelize the worker; serial execution is a
  design decision (single node, one GPU pool).
- **Server reuse key** is the tuple in `LocalRunner._reuse_key` (model, TP
  size, gpu-mem-util, max-model-len, extra args). Benchmark-only param
  changes must NOT restart the server — that is what makes concurrency
  sweeps fast. If you add a server-affecting param, add it to the reuse key
  *and* to `ServerConfig.reuse_key()` in `app/schemas.py`.
- **Downloads always run locally**, even in SLURM mode (compute nodes have
  no internet).
- **Process groups**: every spawned process uses `start_new_session=True`;
  cancellation kills the whole group (SIGTERM → 10 s → SIGKILL). Don't
  replace with `proc.kill()` — vLLM forks workers that would be orphaned.
- **HF token is write-only**: stored in the settings table, sent to
  subprocesses via env (`app/config.py:hf_env`), never returned by the API
  (`public_settings()` masks it to `hf_token_set`). Keep it that way.
- **Extra server args are validated** against shell metacharacters in both
  `schemas.py` (backend) and `benchmark.js` (frontend). Both must stay in
  sync; args are passed via `shlex.split`, never through a shell.
- **Command construction** for both runners goes through
  `app/runners/base.py` (`serve_args` / `bench_args`) so local and SLURM
  behave identically. Change flags there only.
- **Frontend/backed validation parity**: rules in `benchmark.js
  validateParams()` mirror `app/schemas.py`. Update both together.
- Statuses are a closed enum: `queued|downloading|starting_server|
  running_benchmark|completed|failed|cancelled`. The CSS chip classes,
  `PHASE_FILE` log mapping in `app/api/runs.py`, and the SLURM `STATE_MAP`
  all key off these strings.
- No build step, no frontend framework, no WebSockets — polling (3 s status,
  2 s logs) is deliberate for v1.
- Windows is dev-only: the runners use POSIX APIs (`os.killpg`, sessions)
  and are expected to run on Linux. Don't add Windows branches to runners.

## Common tasks

- **Run locally (Linux):** `pip install -r requirements.txt && ./run.sh`
- **Syntax check:** `python -m compileall app`
- **Run tests:** `python -m pytest` (from `vllm-bench-gui/`; pure functions,
  works on Windows too)
- **Fake dashboard data (dev):** `python scripts/seed_demo.py` (10 demo
  runs, `--remove` to clean up; ids prefixed `demo-`)
- **Add a dataset or dataset flag:** one field-spec entry in
  `app/services/dataset_schema.py` (`DATASETS`). The dropdown, sub-fields,
  validation (both sides), badges and argv all derive from it — plus a
  golden-argv case in `tests/test_bench_args.py`.
- **Add a shared benchmark param** (applies to every dataset):
  `schemas.py:BenchConfig` → `base.py:bench_args` → `benchmark.js`
  (`DEFAULT_PARAMS`, `BENCH_FIELDS`, `validateParams`, `submit` payload,
  `flattenConfig`) → `results.py`/`db.py` if it should appear in the
  dashboard.
- **Add a setting:** `config.py:SETTINGS_DEFAULTS` → `schemas.py:SettingsIn`
  → `index.html` settings form → `settings.js` field lists.

## Testing

`tests/` holds the pytest suite (dataset schema validation, golden argv per
dataset, legacy-config migration) — run `python -m pytest`. `test.md` is the
manual test plan for everything that needs a browser, GPU or cluster. When
you add behavior, add a pytest case where the logic is pure and the
corresponding checklist entry to `test.md`.
