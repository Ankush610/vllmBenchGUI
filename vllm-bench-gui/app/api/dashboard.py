"""Dashboard data: parsed metrics for table + charts, CSV export."""
from __future__ import annotations

import csv
import io

from fastapi import APIRouter, Query
from fastapi.responses import StreamingResponse

from app import db

router = APIRouter(prefix="/api/dashboard", tags=["dashboard"])

CSV_COLUMNS = [
    "run_id", "name", "label", "model", "dataset", "backend",
    "max_concurrency", "request_rate", "num_prompts", "input_len",
    "output_len", "req_per_sec", "output_tok_per_sec", "total_tok_per_sec",
    "ttft_p50_ms", "ttft_p99_ms", "tpot_p50_ms", "tpot_p99_ms",
    "e2el_p50_ms", "e2el_p99_ms", "finished_at",
]


@router.get("/results")
def results() -> list[dict]:
    return db.list_results()


@router.get("/export")
def export_csv(ids: str = Query(..., description="comma-separated run ids")):
    run_ids = [i for i in ids.split(",") if i.strip()]
    rows = db.get_results_by_ids(run_ids)
    buf = io.StringIO()
    writer = csv.DictWriter(buf, fieldnames=CSV_COLUMNS, extrasaction="ignore")
    writer.writeheader()
    for row in rows:
        writer.writerow(row)
    buf.seek(0)
    return StreamingResponse(
        iter([buf.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition":
                 "attachment; filename=vllm-bench-results.csv"},
    )
