# test.md — what was tested, and what you should test

## What was verified during development (no GPU machine available)

- [x] All Python modules compile (`python -m compileall app`) — syntax only.
- [x] Code review of flag assembly against the plan (`serve_args`,
      `bench_args`, sbatch template).

## Verified on real hardware — 2026-07-17

Workstation: RTX 5000 Ada (32 GB, GPU 0) + RTX A400 (display-only, GPU 1);
driver 580.142. vLLM 0.24.0 from the Apptainer image via the `bin/vllm` shim;
deps in the `vllm-bench-gui` conda env (Python 3.12).

- [x] **Full local happy path** — `Qwen/Qwen2.5-0.5B-Instruct`, dataset
      `random`, 1000 prompts, concurrency 8, 1024/128 in/out. Walked
      queued → downloading → starting_server → running_benchmark → completed
      in ~4.5 min (bench itself 61 s).
- [x] **`bin/vllm-bench` flag names** — all 16 flags in `runners/base.py`
      accepted by the bundled binary. *Was the highest-risk assumption; closed.*
- [x] **`services/results.py:_pick` against the real output schema** — every
      dashboard number matches the raw JSON exactly. This binary emits
      `median_*`, **not** `p50_*`, so the `median_ttft_ms` / `median_tpot_ms` /
      `median_e2el_ms` fallbacks are the live path — do not remove them.
      `total_token_throughput`, `output_throughput`, `request_throughput` all
      present under their first-choice names. Numbers self-consistent
      (128 000 output tok ÷ 61.18 s = 2092 tok/s = reported `output_throughput`).
- [x] Three phase logs written (`download.log`, `server.log`, `bench.log`);
      exactly one vLLM startup for the run.
- [x] Clean teardown — server killed, GPU 0 back to its 1381 MiB baseline,
      `/api/status` → Idle, no orphan processes.
- [x] `GET /api/status` GPU list matches `nvidia-smi`; `/api/models` lists the
      hub-cache models.
- [x] ApexCharts served from the local `static/vendor/` file (no CDN).
- [x] `hf` resolves to the conda env's copy and `vllm` to the container shim
      inside the running app's PATH.
- [x] `./setup.sh` is idempotent and re-validates a complete environment.

### Fixed while testing on hardware

- [x] **Download progress was invisible.** `hf` disables its tqdm bars when not
      attached to a terminal (a pty does *not* re-enable them — it opts out
      explicitly), so `download.log` held only the final `path=` line.
      `config.py:hf_env` now sets `HF_HUB_DISABLE_PROGRESS_BARS=0`. It logs a
      self-explanatory UserWarning about the override; that is expected.
- [x] **Carriage-return redraws.** tqdm/vLLM redraw with `\r`; the panel used to
      append bytes verbatim, which would pile every redraw onto one endless
      line. `benchmark.js:collapseCarriageReturns` applies terminal semantics
      (last `\r` segment of a line wins), rendering from a raw buffer because a
      redraw can span two polled chunks.
- [ ] **Log phase selector** (`#log-phase`) — needs a UI pass. Auto (default)
      keeps the old live-follow; Download / vLLM server / Benchmark pin the
      panel to one file and re-read it from byte 0. Verify: picking a phase on a
      *completed* run shows it (previously impossible — `?file=auto` falls back
      to `bench` for any non-active status, so finished runs could never show
      their download/server logs); picking a phase that never ran (cached model
      → no download) shows "(no log for this phase)" and self-heals if the log
      later appears; the pick survives switching between runs.

### Known non-blocking issues (not fixed — see plan's fix policy)

- **Preflight GPU accounting vs. GPU pinning.** `services/preflight.py:
  check_gpu_free` counts *any* free GPU, but `bin/vllm` pins vLLM to
  `CUDA_VISIBLE_DEVICES` from `.env`. On this box the A400 (GPU 1) always looks
  "busy" (37% VRAM) while GPU 0 is free, so TP=1 passes correctly. But if GPU 0
  were busy and another GPU free, preflight would pass and vLLM would still try
  the pinned GPU. Harmless on a 1-compute-GPU box; revisit before multi-GPU.
- `GET /favicon.ico` → 404 (cosmetic).
- **Log panel re-renders the whole buffer every poll.** `renderLogs()` collapses
  the entire raw buffer each 2 s tick. Fine at the observed sizes (`server.log`
  was 207 KB for a 0.5B model), but a multi-MB single phase log would need an
  incremental render. The phase selector keeps the buffer to one file, which is
  what makes this a non-issue for now.

## Still untested

Everything below needs the scenarios called out (and a SLURM cluster for §7).

## 1. Smoke tests (do these first)

- [ ] `pip install -r requirements.txt` succeeds on the target machine.
- [ ] `./run.sh` starts; `http://127.0.0.1:8080` serves the UI; no errors in
      uvicorn output.
- [ ] `data/` is created with `app.db`, `logs/`, `results/`, `slurm/`,
      `datasets/`.
- [ ] `bin/vllm-bench --help` runs (binary is executable, right arch).
      **Also verify the flag names** in `app/runners/base.py:bench_args`
      match what this binary version actually accepts (`--dataset-name`,
      `--random-input-len`, `--sharegpt-output-len`, `--sonnet-*`,
      `--percentile-metrics`, `--save-result`, `--result-dir`,
      `--result-filename`, `--base-url`, `--ignore-eos`). This is the
      highest-risk untested assumption in the codebase.
- [ ] `GET /api/status` returns GPU list matching `nvidia-smi`.

## 2. Settings

- [ ] GET/PUT round-trip: change every field, Save, reload page → values
      persist. Footer (model dir, token indicator) updates without reload.
- [ ] HF token: save one → field shows dots, API response contains only
      `hf_token_set: true`, never the token. Blank save keeps it; check it
      reaches `hf download` (gated model downloads work).
- [ ] Dir validation: nonexistent dir outside the project is rejected (400);
      a dir inside the project is auto-created.
- [ ] Execution-mode radio reveals/hides the SLURM block.
- [ ] Invalid SLURM time limit (e.g. `2h`) rejected with a clear message.

## 3. Happy-path local run

- [ ] Queue a small model (e.g. `Qwen/Qwen2.5-0.5B-Instruct`), dataset
      `random`, 50 prompts. Status chip walks queued → downloading (if not
      local) → starting vLLM server → running benchmark → completed.
- [ ] Logs panel streams each phase with `=== DOWNLOAD/VLLM SERVER/BENCHMARK ===`
      headers; stick-to-bottom toggle works.
- [ ] Result JSON appears in `data/results/<run_id>.json`; a row appears in
      the Dashboard table with sane numbers (req/s, tok/s, TTFT, TPOT, E2EL).
      **Verify the parsed numbers against the raw JSON** — key-name fallbacks
      in `app/services/results.py:_pick` are untested against the real
      binary's output schema.
- [ ] Footer server status shows `Serving <model> on :<port>` during the run,
      `Idle` after the queue drains (server torn down).

## 4. Queue, tabs, reuse

- [ ] "+" clones the current tab's params; tab renames to model short-name,
      duplicates get `-2`, `-3`.
- [ ] Submit two tabs with the *same* server config but different
      concurrency: second run must NOT restart the server (server.log has
      one startup; second run's `starting_server` phase is instant with
      detail "reusing running server").
- [ ] Submit two tabs with *different* models: server is torn down and
      restarted between runs; ports freed (no port leak after several runs).
- [ ] Runs execute strictly FIFO, one at a time.
- [ ] Refresh mid-run: page re-hydrates tabs for queued/active runs, log
      tail resumes, drafts (unsubmitted tabs) restored from localStorage.
- [ ] Backend restart mid-run: run is marked `failed (interrupted)`; no
      orphan vLLM process left (check `nvidia-smi`).

## 5. Validation & error paths

- [ ] Each field's blur validation: red border + message (model format, gmu
      0.1–0.99, port range, request rate `inf`/positive, etc.). Submit
      disabled while any tab invalid.
- [ ] Extra server args with `;`, `&&`, `|`, backtick, `$(` rejected in UI
      *and* by the API (try via curl).
- [ ] Nonexistent model repo: download fails → run `failed` with message
      pointing at download.log; queue continues to the next run.
- [ ] Bad extra server arg (e.g. `--nonsense-flag`): server dies → run fails
      with "server exited during startup"; next queued run still executes.
- [ ] Tiny `max_model_len` + huge input_len, or gmu too low: verify OOM
      failures surface with a useful message.
- [ ] Health-check timeout: set timeout to 30 s and load a big model →
      `failed` with timeout message; server process group actually killed.
- [ ] Preflight: run while another process occupies the GPU → fails with
      "not enough free GPUs". TP size > GPU count → clear preflight error.

## 6. Cancel

- [ ] Cancel during download → status `cancelled`, partial download kept
      (re-queue resumes it).
- [ ] Cancel during server startup → server process group killed, port freed.
- [ ] Cancel during benchmark → bench + server killed within ~10 s
      (SIGTERM→SIGKILL), status `cancelled`, partial logs kept.
- [ ] Cancel-all → active run cancelled AND all queued runs flip to
      cancelled.
- [ ] Queue continues after a single cancel (next queued run starts).

## 7. SLURM mode (on the cluster)

- [ ] Settings: partition/GPUs/time/account/extra flags land in the generated
      `data/slurm/<run_id>.sbatch` — inspect the file.
- [ ] Job submits; status shows "waiting in SLURM queue" while PENDING,
      `running_benchmark` while RUNNING; log panel tails `slurm-<jobid>.out`.
- [ ] Completed job → results parsed into dashboard (result JSON path is on
      the shared filesystem).
- [ ] Cancel → `scancel` kills the job; status `cancelled`.
- [ ] Job hits time limit → status `failed` with "time limit" detail.
- [ ] Backend restart while a job is PENDING/RUNNING → job is re-adopted
      (status keeps updating, results parsed on completion).
- [ ] Model download still runs on the login/head node, not in the job.

## 8. Dashboard

- [ ] Six charts render, 3×2, left column throughput / right latency;
      x-labels are `model @ c<N>`.
- [ ] Table checkboxes drive chart series live; select-all works;
      new completed runs appear selected.
- [ ] Bar/Line toggle per chart; line mode enables zoom/pan toolbar.
- [ ] Expand modal (~90% viewport), Esc and × close it, toggle inside works.
- [ ] Concurrency sweep of one model in line mode shows the saturation knee.
- [ ] Sort by model and by date.
- [ ] Delete (row + bulk) asks confirmation and removes DB row, result JSON
      and `data/logs/<run_id>/`.
- [ ] CSV export downloads exactly the selected rows with all columns.
- [ ] Empty state shown when no completed runs.
- [ ] Demo seed: `python scripts/seed_demo.py` populates 10 fake completed
      runs (2 models × 5 concurrencies) — charts + table render them;
      `--remove` deletes all of them (rows + result JSONs), idempotent
      both ways. Works while the server is running.

- [ ] KPI tiles above the charts show peak output/request throughput, best
      TTFT p99 (each with its run) and the selection summary; they update
      live when table checkboxes change and show "—" with nothing selected.
- [ ] Chart colors encode the quantile consistently (p50 light blue,
      p99 dark blue, throughput mid blue) in every chart and its legend.

## 8b. Theming / sidebar

- [ ] Material theme: ripple on buttons/nav/tabs, focus turns field outline
      + label indigo, invalid fields red, tonal status chips.
- [ ] Sidebar collapse: chevron toggles the 232px drawer to a 72px icon
      rail ("vb" monogram, icon-only nav); charts reflow to the new width.
- [ ] Collapsed state persists across page refresh (localStorage) and does
      not affect any other localStorage state (draft tabs survive).

## 9. Datasets

- [ ] `random`, `sharegpt`, `sonnet` built-ins run (sharegpt auto-downloads
      its file — needs internet on first use).
- [ ] `speed-bench` runs: argv contains `--dataset-name speed-bench
      --speed-bench-config <cfg> --output-len <n>`; category/max-input-len
      appear only when set (inspect sbatch script or process cmdline).
- [ ] `hf` runs with a repo ID (e.g. `THUDM/LongBench` + subset/split);
      argv uses `--dataset-path <org/name> --hf-subset --hf-split`.
- [ ] Schema-driven sub-fields: each of the 5 datasets renders its own
      "Dataset options" grid with defaults from `/api/datasets`; switching
      dataset resets edited sub-fields to that dataset's defaults.
- [ ] Network badge under the dropdown updates per selection (offline /
      cached after first run / needs subset+split for offline).
- [ ] `hf` dataset-path must look like `org/name`: a filesystem path is
      rejected in the UI and by the API.
- [ ] Offline mode ON (Datasets tab): hf subset/split become required in
      the form, and a hand-crafted POST /api/runs without them returns 422;
      sharegpt/speed-bench show the amber dataset-path nudge (submit still
      allowed).
- [ ] Drop a `.json`/`.jsonl` in the dataset dir → appears in dropdown as
      `file:<name>`; run uses `--dataset-name sharegpt --dataset-path`;
      optional output-len override works.
- [ ] Path traversal: `file:../../etc/passwd` via curl is rejected.
- [ ] Backward compat: a run queued before the schema change re-hydrates
      into a tab without errors; an old localStorage draft migrates (lengths
      move into the dataset grid); old completed runs keep their In/Out len
      in the dashboard table.

## 9b. Datasets view

- [ ] Datasets tab shows one card per built-in dataset with network badge,
      note and per-flag summary; local files listed in the table below.
- [ ] Offline toggle persists across refresh (`GET /api/settings` returns
      `offline_mode`) and immediately re-validates open Benchmark tabs
      (no page reload needed).
- [ ] Dataset dir path is displayed read-only (setting no longer editable
      in Settings).

## 10. Multi-GPU (if hardware available)

- [ ] TP=2 run works; preflight accepts TP ≤ GPU count and rejects TP >.

## Automated tests

Written (run with `python -m pytest` from `vllm-bench-gui/`, no GPU needed):
- `tests/test_bench_args.py`: exact argv per dataset (all five + `file:*`),
  bool/empty-optional flag omission, legacy-blob replay, tail flags.
- `tests/test_dataset_schema.py`: `validate_params` (types, ranges, selects,
  hf repo-id, shell metachars, offline requiredness), `legacy_to_params`,
  `summary_lengths`.
- `tests/test_schemas.py`: `BenchConfig` legacy migration, unknown-key
  dropping, invalid dataset/param rejection.

Still suggested (not yet written):
- `schemas.py`: shell-metachar rejection on server args, reuse_key.
- `runners/base.py`: sbatch script content (golden-file test).
- `services/results.py`: parse fixture JSONs (both key-name variants);
  missing/corrupt file → ResultParseError.
- `services/model_scan.py`: fake hub-cache tree → repo ids; empty snapshot
  dirs excluded.
- `services/dataset_scan.py`: traversal guard, suffix filter.
- `db.py`: status transitions, timestamps, cascade delete, name dedupe.
- `api/*` via FastAPI TestClient with a stubbed worker: queue → list →
  cancel → delete; log tail offsets (including truncation reset); CSV
  export; settings token masking.

Integration (Linux, mock binaries on PATH):
- Fake `vllm` (tiny HTTP server with /health) + fake `vllm-bench` (writes a
  canned result JSON) → drive the full worker lifecycle including reuse,
  cancel and interruption without a GPU.
