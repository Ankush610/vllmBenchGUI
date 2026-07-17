# CLAUDE.md — project root

This repo holds the **vllm-bench GUI** project:

- `vllm-bench-gui/` — the application (FastAPI backend + vanilla-JS frontend).
  Start with its own [CLAUDE.md](vllm-bench-gui/CLAUDE.md) and
  [README.md](vllm-bench-gui/README.md); the manual/automated test plan is
  [test.md](vllm-bench-gui/test.md).
- `porjectplan/plan.md` — the authoritative spec the code follows, plus UI
  mockup screenshots. Read it before changing behavior.
- `vllm/bin/vllm-bench` — original copy of the Rust benchmark binary
  (bundled into `vllm-bench-gui/bin/`).
- `vllm/container/` — placeholder for the vLLM Apptainer container.

Development happens on Windows but the app targets Linux (workstation or
PARAM Shavak with SLURM) — runners use POSIX process groups and cannot run
on Windows.
