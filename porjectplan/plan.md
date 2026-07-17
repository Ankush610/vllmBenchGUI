# vllm-bench GUI — Project Plan

A simple web GUI for running [vllm-project/vllm-bench](https://github.com/vllm-project/vllm-bench) benchmarks: queue models, auto-download, auto-serve with vLLM, benchmark, and visualize results. Built for single-node use (workstation or PARAM Shavak), with optional SLURM execution.

**Design principle:** simplicity over completeness. Expose only the parameters that matter; hardcode sane defaults for everything else. Serial execution, one run at a time.

---

## 1. Tech stack

| Layer | Choice |
|---|---|
| Backend | Python, FastAPI, uvicorn |
| Job execution | `subprocess` process groups (local) / `sbatch` + `squeue` (SLURM) |
| Storage | SQLite (run history, parsed metrics, settings) + flat files (logs, raw result JSONs) |
| Frontend | Vanilla HTML/CSS/JS, single page, no build step |
| Charts | ApexCharts |
| Theme | Light-mode only, AdminLTE-style admin layout (sidebar + content) |
| Benchmark client | `vllm-bench` Rust binary, bundled in `bin/` |

---

## 2. Directory structure

```
vllm-bench-gui/
├── run.sh                        # uvicorn launcher
├── requirements.txt
├── bin/
│   └── vllm-bench                # bundled Rust binary
│
├── app/                          # FastAPI backend
│   ├── main.py                   # app entry, mounts static + API routers, startup reconciliation
│   ├── config.py                 # settings load/save
│   ├── db.py                     # SQLite init + queries
│   ├── schemas.py                # Pydantic models (RunConfig, RunStatus, Settings)
│   ├── queue_worker.py           # single asyncio worker: dequeue → lifecycle state machine
│   ├── runners/
│   │   ├── base.py               # Runner interface: prepare / serve / bench / cancel / status
│   │   ├── local_runner.py       # subprocess + process groups + port allocation + server reuse
│   │   └── slurm_runner.py       # sbatch generation, squeue polling, scancel
│   ├── services/
│   │   ├── model_scan.py         # scan HF hub cache for local models
│   │   ├── dataset_scan.py       # scan dataset dir for dataset files
│   │   ├── downloader.py         # hf download subprocess (always local, never SLURM)
│   │   ├── preflight.py          # binary/GPU/disk checks before each run
│   │   └── results.py            # parse vllm-bench result JSON → DB rows
│   └── api/
│       ├── runs.py               # queue, list, cancel, delete, logs
│       ├── settings.py           # GET/PUT settings
│       ├── models_api.py         # GET local model list
│       ├── datasets_api.py       # GET dataset list (built-ins + scanned files)
│       └── dashboard.py          # GET results for table + charts, CSV export
│
├── static/                       # frontend, served by FastAPI
│   ├── index.html                # single page: Benchmark / Dashboard / Settings views
│   ├── css/
│   │   └── theme.css
│   ├── js/
│   │   ├── api.js                # fetch wrappers
│   │   ├── benchmark.js          # tabs, param grid, validation, log polling, submit/cancel
│   │   ├── dashboard.js          # ApexCharts + results table
│   │   └── settings.js
│   └── vendor/
│       └── apexcharts.min.js
│
└── data/                         # runtime state (gitignored)
    ├── app.db
    ├── logs/<run_id>/            # download.log, server.log, bench.log (or slurm-<jobid>.out)
    ├── results/<run_id>.json     # raw vllm-bench output (kept for re-parse / export)
    └── slurm/<run_id>.sbatch     # generated job scripts (SLURM mode, kept for debugging)
```

---

## 3. Settings

Stored in SQLite (`settings` table), edited on the Settings page, mirrored read-only in the Benchmark footer.

| Setting | Default | Notes |
|---|---|---|
| Model dir | `~/.cache/huggingface/hub` | Scanned for the model dropdown; also `HF_HOME`-style target for downloads |
| Dataset dir | `./data/datasets` | Scanned for the dataset dropdown |
| HF token | empty | Stored server-side only; UI shows `Loaded ✓` / `Not set`, never the token |
| Results dir | `./data/results` | Where vllm-bench JSONs land |
| Port range start | `8000` | Local mode: auto-assign next free port from here |
| Execution mode | `local` | `local` \| `slurm` |
| Bind address | `127.0.0.1` | `127.0.0.1` (only this machine) or `0.0.0.0` (LAN). No auth in v1 — LAN exposure is a deliberate choice |
| **SLURM (shown only when mode = slurm)** | | |
| Partition | empty | `#SBATCH --partition` |
| GPUs per job | `1` | `#SBATCH --gres=gpu:N` |
| Time limit | `02:00:00` | `#SBATCH --time` |
| Account / project | empty | optional `#SBATCH --account` |
| Extra SBATCH flags | empty | free text, appended verbatim |

Save validates that dirs exist (creates them if inside the project) and updates footer indicators instantly.

---

## 4. Database schema (SQLite)

```sql
-- one row per queued/executed run
CREATE TABLE runs (
  id            TEXT PRIMARY KEY,          -- uuid
  name          TEXT,                       -- tab name, defaults to model short-name (deduped -2, -3)
  label         TEXT,                       -- optional free-text note
  status        TEXT NOT NULL,              -- queued|downloading|starting_server|running_benchmark|completed|failed|cancelled
  status_detail TEXT,                       -- e.g. "failed (interrupted)", health-check timeout msg
  config_json   TEXT NOT NULL,              -- full RunConfig (server + bench params)
  runner        TEXT NOT NULL,              -- local|slurm
  slurm_job_id  TEXT,                       -- slurm mode only
  port          INTEGER,                    -- local mode only
  created_at    TEXT NOT NULL,
  started_at    TEXT,
  finished_at   TEXT
);

-- parsed metrics, one row per completed run (drives dashboard)
CREATE TABLE results (
  run_id            TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
  model             TEXT NOT NULL,
  dataset           TEXT NOT NULL,
  backend           TEXT NOT NULL,
  max_concurrency   INTEGER,
  request_rate      TEXT,
  num_prompts       INTEGER,
  input_len         INTEGER,
  output_len        INTEGER,
  req_per_sec       REAL,
  output_tok_per_sec REAL,
  total_tok_per_sec REAL,
  ttft_p50_ms       REAL, ttft_p99_ms REAL,
  tpot_p50_ms       REAL, tpot_p99_ms REAL,
  e2el_p50_ms       REAL, e2el_p99_ms REAL,
  result_path       TEXT NOT NULL           -- raw JSON on disk
);

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);
```

---

## 5. API endpoints

| Method & path | Purpose |
|---|---|
| `POST /api/runs` | Queue one or more run configs (Submit). Returns run ids. |
| `GET /api/runs` | All runs with statuses (frontend re-hydration + status polling). |
| `POST /api/runs/{id}/cancel` | Cancel active run (queue continues). |
| `POST /api/runs/cancel-all` | Cancel active run and clear queued runs. |
| `DELETE /api/runs/{id}` | Delete run record + result JSON + logs (confirmation in UI). |
| `GET /api/runs/{id}/logs?file=bench&offset=N` | Byte-offset log tail; returns new bytes + next offset. |
| `GET /api/models` | Scan model dir → local model list (name + "local" badge info). |
| `GET /api/datasets` | Built-ins (`random`, `sonnet`, `sharegpt` auto-download) + scanned files from dataset dir. |
| `GET /api/dashboard/results` | Parsed metrics for table + charts. |
| `GET /api/dashboard/export?ids=...` | CSV of selected runs. |
| `GET /api/settings` / `PUT /api/settings` | Read / save settings. |
| `GET /api/status` | Global status: worker state, active vLLM server (model, port), GPU free/busy. |

Polling intervals: run statuses + global status every 3 s; active log tail every 2 s. No WebSockets in v1.

---

## 6. Run parameters

### 6.1 vLLM server parameters

| Param | UI type | Default | Placeholder | "i" tooltip | Validation |
|---|---|---|---|---|---|
| Model | Searchable dropdown + free text | — (required) | `Qwen/Qwen2.5-7B-Instruct` | Pick a local model or type any HF repo ID; missing models auto-download | `org/name` pattern or exists in scan; badge shows local / will download |
| Tensor parallel size | Dropdown 1/2/4/8 | `1` | — | Number of GPUs the model is sharded across; must be ≤ GPUs on this node | int ≤ detected GPU count |
| GPU memory utilization | Number | `0.90` | `0.90` | Fraction of each GPU's VRAM vLLM may reserve for weights + KV cache | float 0.1–0.99 |
| Max model len | Number (optional) | auto | `8192` | Max context length; leave empty for model's native limit; lower it on KV-cache OOM | int ≥ 256 or empty |
| Port | Number (optional) | auto | `8000` | Server port; auto-assigns next free port if empty (local mode) | int 1024–65535, free |
| Extra server args | Text, collapsed "Advanced" | empty | `--enable-prefix-caching` | Raw flags appended to `vllm serve` as-is | shell-safe tokens only: reject `;`, `&&`, `|`, backticks, `$(` |

### 6.2 Benchmark parameters

| Param | UI type | Default | Placeholder | "i" tooltip | Validation |
|---|---|---|---|---|---|
| Backend | Dropdown | `vllm` | — | `vllm` = /v1/completions (raw throughput); `openai-chat` = /v1/chat/completions (realistic chat serving) | enum |
| Dataset | Auto-populated dropdown | `random` | — | `random` = synthetic exact-length prompts; `sharegpt` = real conversations; `sonnet` = built-in, prefix-cache friendly; local files listed from dataset dir | enum + scanned files |
| Input length | Number | `1024` | `1024` | Prompt length in tokens per request (random dataset) | int 1–131072 |
| Output length | Number | `128` | `128` | Tokens generated per request | int 1–32768 |
| Num prompts | Number | `1000` | `1000` | Total requests in this run; more = tighter percentiles, longer runtime | int 1–1000000 |
| Max concurrency | Number | `200` | `200` | Max requests in flight; the main knob for saturating the server | int ≥ 1 |
| Request rate | Number or `inf` | `inf` | `inf` | Requests/sec arrival rate; `inf` = closed loop bounded only by concurrency | float > 0 or `inf` |
| Ignore EOS | Toggle | on | — | Force full output length even if the model wants to stop early; keeps token counts exact | bool |
| Seed | Number | `0` | `0` | Same seed + params = same prompts, reproducible runs | int ≥ 0 |

**Conditional fields (same grid slots, labels swap by dataset):**
- `random` → input length + output length (`--random-input-len`, `--random-output-len`)
- `sharegpt` / scanned file → output-len override only (`--sharegpt-output-len`); scanned file also sets `--dataset-path`
- `sonnet` → sonnet input / output / prefix lengths

**Always sent silently:** `--save-result --result-dir <results dir> --result-filename <run_id>.json --percentile-metrics ttft,tpot,itl,e2el --base-url http://127.0.0.1:<port>`.

**Validation UX:** validate on blur; invalid field gets red border + inline message; Submit disabled while any tab has an invalid field.

**Out of scope for v1:** sweeps (queue tabs manually instead), multi-turn, LoRA, embeddings/pooling, profiling.

---

## 7. Run lifecycle

### 7.1 State machine

```
queued → downloading → starting_server → running_benchmark → completed
                 └──────────┴──────────────┴────→ failed / cancelled
```

Per run, the queue worker (single asyncio task, strictly serial):

1. **Dequeue** next `queued` run (FIFO).
2. **Preflight** — `vllm-bench` binary present & executable; GPU free (`nvidia-smi` query, local mode); disk space sufficient if a download is needed. Failure → `failed` with clear message, continue to next run.
3. **Model check** — scan model dir; if missing → **download** via `hf download` (always a local subprocess, even in SLURM mode — compute nodes have no internet). `hf` resumes partial downloads, so a cancelled download is never wasted.
4. **Serve** — start vLLM server (runner-specific, see below). Status `starting_server`.
5. **Health check** — poll `/health` until ready; timeout (default 600 s) or process death → `failed`.
6. **Benchmark** — run `vllm-bench` with assembled flags. Status `running_benchmark`.
7. **Parse** — read result JSON → insert `results` row. Non-zero exit or missing/invalid JSON → `failed`.
8. **Teardown / reuse decision** — compare next queued run's server tuple `(model, tp_size, gpu_mem_util, max_model_len, extra_server_args)`:
   - identical (local mode only) → keep server running, skip steps 4–5 for the next run;
   - different, queue empty, or SLURM mode → teardown (kill process group / job ends), free port.
9. **Complete** → `completed`, dequeue next.

Benchmark-only param changes (concurrency, num prompts, dataset, request rate, seed…) never trigger a server restart — this is what makes manual concurrency sweeps fast.

### 7.2 Local runner

- Every spawned process uses `start_new_session=True` → its own process group.
- Port allocation: next free port from configured range start; recorded on the run row.
- Logs: stdout/stderr of each phase redirected to `data/logs/<run_id>/{download,server,bench}.log`.
- **Cancel:** `SIGTERM` to the active process group → wait 10 s → `SIGKILL` if alive → verify port freed → mark `cancelled`, keep partial logs, queue continues. "Cancel all" additionally flips all `queued` rows to `cancelled`.

### 7.3 SLURM runner

- One generated `sbatch` script per run (`data/slurm/<run_id>.sbatch`) executing **on the compute node**: start `vllm serve` in background → health-check loop → run `vllm-bench` against `127.0.0.1` → kill server → exit. Single job avoids cross-node server discovery entirely.
- `#SBATCH` headers from settings (partition, gres, time, account, extra flags); job output to `data/logs/<run_id>/slurm-%j.out` (shared filesystem → log polling works unchanged).
- Status mapping: `squeue`/`sacct` polled every 3 s → PENDING = `starting_server` (shown as "waiting in SLURM queue"), RUNNING = `running_benchmark`, COMPLETED = parse results, FAILED/TIMEOUT = `failed`.
- **Cancel:** `scancel <jobid>` — SLURM kills the whole job step (server + bench) cleanly.
- Server reuse is not available in SLURM mode (each run = one job) — acceptable trade-off.

### 7.4 Startup reconciliation

On backend boot: any run stuck in an active status with no live process → `failed (interrupted)`. In SLURM mode, re-sync from `squeue`/`sacct` first — a job that survived a backend restart is re-adopted, not orphaned.

---

## 8. UI specification

Single page, three views via sidebar: **Benchmark**, **Dashboard**, **Settings**.

### 8.1 Benchmark view

| Component | Behavior |
|---|---|
| Run tabs + "+" | Each tab = one run config. Tab auto-renames to model short-name on selection (deduped `-2`, `-3`). "+" clones the current tab's params (fast sweeps). Tabs closable while draft/queued; locked once active. |
| Status chip (top right) | Current run's state, color-coded (gray queued, blue downloading, amber starting, purple running, green completed, red failed, gray cancelled). Clicking jumps logs to that run. |
| Param grid | Two labeled groups (Server / Benchmark). Each cell: label + "i" tooltip + input with gray placeholder. Blur validation, red border + message on error. |
| Model dropdown | Opens → `GET /api/models` scan; searchable; free text allowed for HF repo IDs; badge "local" vs "will download". |
| Dataset dropdown | Opens → `GET /api/datasets`; built-ins + files scanned from dataset dir; picking a file sets `--dataset-name sharegpt --dataset-path <file>`. |
| Label field | Optional one-line note per run, shown in dashboard table. |
| Logs panel | Tail-follow of active run's current phase log, 2 s polling with byte offsets, phase headers injected (`=== DOWNLOAD ===`, `=== VLLM SERVER ===`, `=== BENCHMARK ===`), stick-to-bottom toggle. |
| Submit | Validates all draft tabs → `POST /api/runs`. Later-added tabs just append to the queue. |
| Cancel | Cancels active run only; queue continues. Dropdown holds "Cancel all". |
| Footer left | Current model dir + HF token indicator (`Loaded ✓` / `Not set`), mirrored from Settings. |
| Footer right | vLLM server status: `Idle` / `Starting…` / `Serving <model> on :<port>` (SLURM: `Job <id> pending/running`), colored dot. |

### 8.2 Dashboard view

**Charts** — six, in a symmetric 3×2 grid: left column = throughput, right column = latency. Grouped by model name; series drawn only for table-selected runs; x-labels `model @ c<concurrency>`:

| Chart (position) | X → Y | Why it's useful |
|---|---|---|
| Output token throughput (L1) | runs → output tok/s | Headline number: raw generation capacity on this hardware |
| Request throughput (L2) | runs → req/s | Serving capacity in product terms — users served per second |
| Total token throughput (L3) | runs → total tok/s | Input + output combined — the fair comparison when runs use different input lengths, since prefill work is invisible in output-only numbers |
| TTFT p50 + p99 (R1) | runs → ms (2 series) | Perceived responsiveness; p99 exposes queueing pain the median hides |
| TPOT p50 + p99 (R2) | runs → ms/token (2 series) | Streaming smoothness under load — fluid vs choppy output |
| E2EL p99 (R3) | runs → s | Tail latency SLO — worst case a user experiences |

Line mode on a concurrency sweep of one model shows the saturation knee (throughput flattens while TTFT p99 explodes).

**Per-chart controls** (top-right of each card):
- **Bar/Line toggle** — switches chart style.
- **Expand button** — opens the chart in a large overlay modal (~90% of viewport) for detail viewing; Esc or × closes. Same chart re-rendered at full size, toggle still available inside.
- **Zoom/pan** — ApexCharts' built-in toolbar (box-zoom, pan, reset) enabled in line mode, both in-grid and in the expanded modal.

**Table** — one row per completed run: checkbox · model · label · dataset · backend · concurrency · input/output len · req/s · output tok/s · TTFT p50/p99 · TPOT p50/p99 · E2EL p99 · date. Features: select/deselect all (charts update live), sort by model name or most-recent-first, delete with confirmation (removes DB rows + result JSON + logs), CSV export of selected rows.

### 8.3 Settings view

Form for every setting in §3, execution-mode radio reveals the SLURM block, Save button with validation. Token field is write-only (shows placeholder dots once set).

### 8.4 Refresh persistence

The frontend holds **zero authoritative state**. Queue, statuses, logs, results, and settings live in the backend; the worker runs regardless of open browsers. On page load the frontend re-hydrates from `GET /api/settings`, `/api/runs`, `/api/status`, `/api/dashboard/results` and resumes log polling. The only client-side state — unsubmitted draft tabs — is mirrored to `localStorage` on every change, so even drafts survive a refresh.

---

## 9. Milestones

| # | Milestone | Contents |
|---|---|---|
| 1 | Skeleton | FastAPI app, SQLite schema, settings API + page, static serving, model/dataset scan endpoints |
| 2 | Local pipeline | Queue worker, local runner (download → serve → health → bench → parse), cancel, preflight, log tailing |
| 3 | Benchmark UI | Tabs, param grid + validation, tooltips, submit/cancel, status chip, footer indicators, log panel, localStorage drafts |
| 4 | Dashboard | Results table (select/sort/delete/export) + 6 ApexCharts (3×2 grid) with bar/line toggle, expand modal, zoom/pan |
| 5 | SLURM mode | sbatch generation, squeue polling, scancel, SLURM settings, startup reconciliation for jobs |
| 6 | Polish | Error surfacing, empty states, confirmation dialogs, README |

Milestones 1–4 make the tool fully usable on a workstation; 5 adds PARAM Shavak SLURM support.
