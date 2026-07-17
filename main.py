"""
FastAPI application — Interactive Tables Live Poll Demo (SPCS).
Serves admin and dashboard pages; vote submission is handled by the Cloudflare Worker.
"""
import logging
import time
import uuid
from collections import defaultdict
from pathlib import Path

import snowflake.connector
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, field_validator

import config

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# In-memory state
# ---------------------------------------------------------------------------
_active_question: dict | None = None
_results_cache:   dict = {}
_results_cache_ts: float = 0.0


# ---------------------------------------------------------------------------
# Snowflake connector — SPCS workload-identity OAuth token via internal host
# ---------------------------------------------------------------------------
def _get_conn(warehouse: str = "DEMO_STD_WH"):
    return snowflake.connector.connect(
        host=config.SNOWFLAKE_HOST,
        account=config.SNOWFLAKE_ACCOUNT,
        authenticator="oauth",
        token=config.get_spcs_token(),
        role=config.SNOWFLAKE_ROLE,
        database=config.SNOWFLAKE_DATABASE,
        schema=config.SNOWFLAKE_SCHEMA,
        warehouse=warehouse,
    )


app = FastAPI(title="Interactive Tables Live Poll Demo")

static_dir = Path(__file__).parent / "static"
app.mount("/static", StaticFiles(directory=str(static_dir)), name="static")



# ---------------------------------------------------------------------------
# HTML page routes
# ---------------------------------------------------------------------------
@app.get("/")
async def root():
    return FileResponse(str(static_dir / "dashboard.html"))

@app.get("/dashboard")
async def dashboard_page():
    return FileResponse(str(static_dir / "dashboard.html"))

@app.get("/vote")
async def vote_page():
    return FileResponse(str(static_dir / "vote.html"))

@app.get("/admin")
async def admin_page():
    return FileResponse(str(static_dir / "admin.html"))


# ---------------------------------------------------------------------------
# GET /api/config  — public vote URL for dashboard QR code
# ---------------------------------------------------------------------------
@app.get("/api/config")
async def get_config():
    return {"public_vote_url": config.PUBLIC_VOTE_URL or None}


# ---------------------------------------------------------------------------
# POST /api/question  — create + activate a question (admin only)
# ---------------------------------------------------------------------------
class QuestionRequest(BaseModel):
    question_text: str
    context_text: str = ""
    category: str = ""
    options: list[str]
    allow_multiple_votes: bool = False

    @field_validator("question_text")
    @classmethod
    def question_not_empty(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("question_text cannot be empty")
        return v

    @field_validator("options")
    @classmethod
    def validate_options(cls, v: list[str]) -> list[str]:
        v = [o.strip() for o in v if o.strip()]
        if len(v) < 2:
            raise ValueError("At least 2 non-empty options are required")
        if len(v) > 6:
            raise ValueError("Maximum 6 options allowed")
        return v


@app.post("/api/question")
async def create_question(req: QuestionRequest):
    global _active_question, _results_cache, _results_cache_ts

    question_id = str(uuid.uuid4())
    options = [
        {
            "option_id": str(uuid.uuid4()),
            "question_id": question_id,
            "option_text": text,
            "display_order": i + 1,
        }
        for i, text in enumerate(req.options)
    ]

    try:
        conn = _get_conn()
        cur  = conn.cursor()
        cur.execute(
            """INSERT OVERWRITE INTO dim_questions
               (question_id, question_text, context_text, category, is_active, allow_multiple_votes, created_at)
               VALUES (%s, %s, %s, %s, TRUE, %s, CURRENT_TIMESTAMP())""",
            (question_id, req.question_text, req.context_text, req.category, req.allow_multiple_votes),
        )
        values_sql  = ", ".join(["(%s, %s, %s, %s)"] * len(options))
        flat_params = []
        for opt in options:
            flat_params.extend([opt["option_id"], opt["question_id"], opt["option_text"], opt["display_order"]])
        cur.execute(
            f"INSERT OVERWRITE INTO dim_answer_options (option_id, question_id, option_text, display_order) VALUES {values_sql}",
            flat_params,
        )
        cur.close()
        conn.close()
    except Exception as exc:
        logger.error("Failed to write question: %s", exc)
        raise HTTPException(status_code=500, detail=f"Snowflake error: {exc}")

    _active_question  = {
        "question_id":           question_id,
        "question_text":         req.question_text,
        "context_text":          req.context_text,
        "category":              req.category,
        "allow_multiple_votes":  req.allow_multiple_votes,
        "options":               options,
        "option_ids":            {opt["option_id"] for opt in options},
    }
    _results_cache    = {}
    _results_cache_ts = 0.0

    logger.info("Activated question: %s (%d options)", question_id, len(options))
    return {"question_id": question_id, "options": len(options)}


# ---------------------------------------------------------------------------
# GET /api/active  — active question for the SPCS vote.html fallback page
# ---------------------------------------------------------------------------
@app.get("/api/active")
async def get_active():
    if _active_question is None:
        return {"active": False}
    return {
        "active":               True,
        "question_id":          _active_question["question_id"],
        "question_text":        _active_question["question_text"],
        "context_text":         _active_question["context_text"],
        "allow_multiple_votes": _active_question.get("allow_multiple_votes", False),
        "options": [
            {"option_id": o["option_id"], "option_text": o["option_text"], "display_order": o["display_order"]}
            for o in _active_question["options"]
        ],
    }


# ---------------------------------------------------------------------------
# GET /api/results  — live vote counts (500ms server-side cache)
# ---------------------------------------------------------------------------
_RESULTS_QUERY = """
SELECT
    a.option_text,
    a.display_order,
    COUNT(p.prediction_id)                                                AS vote_count,
    ROUND(
        100.0 * COUNT(p.prediction_id)
        / NULLIF(SUM(COUNT(p.prediction_id)) OVER (), 0), 1
    )                                                                     AS vote_pct,
    DATEDIFF('millisecond',
        MAX(p.predicted_at),
        CONVERT_TIMEZONE('UTC', CURRENT_TIMESTAMP())::TIMESTAMP_NTZ
    )                                                                     AS freshness_ms
FROM dim_answer_options a
LEFT JOIN fact_predictions p
       ON a.option_id    = p.option_id
      AND p.predicted_at >= DATEADD('hour', -2,
              CONVERT_TIMEZONE('UTC', CURRENT_TIMESTAMP())::TIMESTAMP_NTZ)
WHERE a.question_id = %s
GROUP BY a.option_text, a.display_order
ORDER BY a.display_order
"""

_VOTES_PER_SEC_QUERY = """
SELECT COUNT(*) / 60.0 AS votes_per_sec
FROM fact_predictions
WHERE question_id   = %s
  AND predicted_at >= DATEADD('minute', -1,
          CONVERT_TIMEZONE('UTC', CURRENT_TIMESTAMP())::TIMESTAMP_NTZ)
"""


@app.get("/api/results")
async def get_results():
    global _results_cache, _results_cache_ts

    if _active_question is None:
        return {"active": False}

    now_ms = time.time() * 1000
    if _results_cache and (now_ms - _results_cache_ts) < config.CACHE_TTL_MS:
        return _results_cache

    question_id = _active_question["question_id"]
    try:
        conn = _get_conn(warehouse="DEMO_IWT_WH")
        cur  = conn.cursor()
        t0   = time.perf_counter()
        cur.execute(_RESULTS_QUERY, (question_id,))
        rows     = cur.fetchall()
        query_ms = round((time.perf_counter() - t0) * 1000)
        cur.execute(_VOTES_PER_SEC_QUERY, (question_id,))
        vps_row      = cur.fetchone()
        votes_per_sec = round(float(vps_row[0] or 0), 1) if vps_row else 0.0
        cur.close()
        conn.close()
    except Exception as exc:
        logger.error("Results query error: %s", exc)
        raise HTTPException(status_code=500, detail=f"Query error: {exc}")

    options_out  = []
    total_votes  = 0
    freshness_ms = None
    for row in rows:
        option_text, display_order, vote_count, vote_pct, fms = row
        total_votes += int(vote_count or 0)
        if fms is not None and freshness_ms is None:
            freshness_ms = int(fms)
        options_out.append({
            "option_text":   option_text,
            "display_order": display_order,
            "vote_count":    int(vote_count or 0),
            "vote_pct":      float(vote_pct or 0),
        })

    _results_cache = {
        "active":        True,
        "question_id":   question_id,
        "question_text": _active_question["question_text"],
        "context_text":  _active_question["context_text"],
        "options":       options_out,
        "total_votes":   total_votes,
        "votes_per_sec": votes_per_sec,
        "freshness_ms":  freshness_ms,
        "query_ms":      query_ms,
    }
    _results_cache_ts = now_ms
    return _results_cache


# ---------------------------------------------------------------------------
# GET /api/compare  — run same query on both warehouses
# ---------------------------------------------------------------------------
_COMPARE_QUERY = """
SELECT a.option_text, COUNT(p.prediction_id) AS vote_count
FROM dim_answer_options a
LEFT JOIN fact_predictions p
       ON a.option_id   = p.option_id
      AND p.predicted_at >= DATEADD('hour', -2,
              CONVERT_TIMEZONE('UTC', CURRENT_TIMESTAMP())::TIMESTAMP_NTZ)
WHERE a.question_id = %s
GROUP BY a.option_text
ORDER BY a.option_text
"""


def _run_timed_query(warehouse: str, question_id: str) -> dict:
    conn = _get_conn(warehouse=warehouse)
    cur  = conn.cursor()
    t0   = time.perf_counter()
    cur.execute(_COMPARE_QUERY, (question_id,))
    cur.fetchall()
    elapsed_ms = round((time.perf_counter() - t0) * 1000)
    cur.close()
    conn.close()
    return {"warehouse": warehouse, "elapsed_ms": elapsed_ms}


@app.get("/api/compare")
async def compare_warehouses():
    if _active_question is None:
        raise HTTPException(status_code=409, detail="No active question")

    question_id = _active_question["question_id"]
    results, errors = {}, {}
    for wh in ("DEMO_IWT_WH", "DEMO_STD_WH"):
        try:
            results[wh] = _run_timed_query(wh, question_id)
        except Exception as exc:
            logger.error("Compare query error on %s: %s", wh, exc)
            errors[wh] = str(exc)

    return {
        "interactive": results.get("DEMO_IWT_WH"),
        "standard":    results.get("DEMO_STD_WH"),
        "errors":      errors or None,
    }
