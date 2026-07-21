import asyncio
import io
import json
import os
import sqlite3
import sys
import threading
import uuid
from datetime import datetime
from pathlib import Path
from typing import Optional

from fastapi import BackgroundTasks, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse
from pydantic import BaseModel

import main as agent
import rag_agent

app = FastAPI(title="BI Research API")

# The sidecar is a server-to-server API called by the Node layer, not a browser.
# Restrict CORS to configured origins (defaults to the local Node server).
_origins = os.environ.get("RESEARCH_CORS_ORIGINS", "http://localhost:3001").split(",")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in _origins if o.strip()],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Optional shared-secret gate. If RESEARCH_API_KEY is set, every /api/* request
# must present it via the X-API-Key header (the Node client sends it). This
# stops direct access to the sidecar even if the port is reachable.
API_KEY = os.environ.get("RESEARCH_API_KEY")


@app.middleware("http")
async def require_api_key(request: Request, call_next):
    if API_KEY and request.url.path.startswith("/api/"):
        if request.headers.get("x-api-key") != API_KEY:
            return JSONResponse({"detail": "Unauthorized"}, status_code=401)
    return await call_next(request)

# ---------------------------------------------------------------------------
# Database Setup
# ---------------------------------------------------------------------------
DB_PATH = Path("jobs.db")
LOGS_DIR = Path("logs")
LOGS_DIR.mkdir(exist_ok=True)

def init_db():
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA busy_timeout=5000")
        conn.execute("""
            CREATE TABLE IF NOT EXISTS jobs (
                id TEXT PRIMARY KEY,
                job_type TEXT,
                status TEXT,
                result_files TEXT,
                created_at TEXT
            )
        """)
        # Reconciliation: jobs run in-process, so any left "running" after a
        # restart are orphaned — mark them failed instead of stranding them.
        conn.execute("UPDATE jobs SET status='failed' WHERE status='running'")

init_db()

def update_job(job_id: str, status: str, result_files: Optional[dict] = None):
    with sqlite3.connect(DB_PATH) as conn:
        res_str = json.dumps(result_files) if result_files else None
        if result_files is not None:
            conn.execute("UPDATE jobs SET status = ?, result_files = ? WHERE id = ?", (status, res_str, job_id))
        else:
            conn.execute("UPDATE jobs SET status = ? WHERE id = ?", (status, job_id))

# ---------------------------------------------------------------------------
# Thread Stdout Routing for Logs
# ---------------------------------------------------------------------------
class ThreadStdoutRouter(io.TextIOBase):
    def __init__(self, fallback) -> None:
        self._fallback = fallback
        self._writers = {}

    def register(self, writer: io.TextIOBase) -> None:
        self._writers[threading.get_ident()] = writer

    def unregister(self) -> None:
        self._writers.pop(threading.get_ident(), None)

    def _target(self):
        return self._writers.get(threading.get_ident(), self._fallback)

    def write(self, s: str) -> int:
        return self._target().write(s)

    def flush(self) -> None:
        target = self._target()
        if hasattr(target, "flush"):
            target.flush()

stdout_router = ThreadStdoutRouter(sys.stdout)
sys.stdout = stdout_router

def run_job_task(job_id: str, job_type: str, memory_key: str, fn, *args):
    log_path = LOGS_DIR / f"{job_id}.log"
    log_file = open(log_path, "w", encoding="utf-8", buffering=1)
    stdout_router.register(log_file)
    try:
        print(f"--- Starting Job {job_id} at {datetime.now()} ---")
        result = fn(*args)

        # Map outputs to dictionary format based on fn
        if fn == agent.run_report:
            res_dict = {"md": str(result), "pdf": str(result.with_suffix(".pdf")) if result.with_suffix(".pdf").exists() else None}
        elif fn == agent.run_lead_finding:
            res_dict = {"csv": str(result[0]), "md": str(result[1]), "pdf": str(result[1].with_suffix(".pdf")) if result[1].with_suffix(".pdf").exists() else None}
        elif fn == agent.run_company_profile:
            res_dict = {"md": str(result), "pdf": str(result.with_suffix(".pdf")) if result.with_suffix(".pdf").exists() else None}
        else:
            res_dict = {}

        # Feed the outputs into the company's RAG knowledge store. A failure
        # here must not fail the research job itself.
        if memory_key:
            try:
                print(f"--- Updating RAG knowledge store for {memory_key} ---")
                rag_agent.ingest_job_outputs(get_client(), memory_key, job_type, res_dict)
            except Exception as exc:
                print(f"  ! RAG ingestion failed (job outputs are still saved): {exc}")

        print(f"--- Job completed successfully ---")
        update_job(job_id, "completed", res_dict)
    except SystemExit:
        print("--- Job exited early (see log above) ---")
        update_job(job_id, "failed")
    except Exception as exc:
        print(f"--- Job failed: {exc} ---")
        update_job(job_id, "failed")
    finally:
        stdout_router.unregister()
        log_file.flush()
        log_file.close()


def get_client() -> agent.Mistral:
    if not agent.MISTRAL_API_KEY:
        raise ValueError("MISTRAL_API_KEY is not set.")
    return agent.Mistral(api_key=agent.MISTRAL_API_KEY)

# ---------------------------------------------------------------------------
# API Endpoints
# ---------------------------------------------------------------------------

class ReportRequest(BaseModel):
    topic: str
    no_pdf: bool = False
    memory_key: str = ""

@app.post("/api/jobs/report")
def create_report_job(req: ReportRequest, background_tasks: BackgroundTasks):
    job_id = str(uuid.uuid4())
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute("INSERT INTO jobs (id, job_type, status, created_at) VALUES (?, ?, ?, ?)",
                     (job_id, "report", "running", datetime.now().isoformat()))

    background_tasks.add_task(run_job_task, job_id, "report", req.memory_key,
                              agent.run_report, get_client(), req.topic, req.no_pdf)
    return {"job_id": job_id}

class LeadsRequest(BaseModel):
    company_url: str
    audience: str = ""
    count: int = 150
    no_pdf: bool = False
    memory_key: str = ""
    location: str = ""      # lead search area; auto-detected from the site if empty
    radius_km: int = 80

@app.post("/api/jobs/leads")
def create_leads_job(req: LeadsRequest, background_tasks: BackgroundTasks):
    job_id = str(uuid.uuid4())
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute("INSERT INTO jobs (id, job_type, status, created_at) VALUES (?, ?, ?, ?)",
                     (job_id, "leads", "running", datetime.now().isoformat()))

    background_tasks.add_task(run_job_task, job_id, "leads", req.memory_key or req.company_url,
                              agent.run_lead_finding, get_client(), req.company_url, req.audience, req.count, req.no_pdf,
                              req.location, req.radius_km)
    return {"job_id": job_id}

class ProfileRequest(BaseModel):
    company_name_or_url: str
    no_pdf: bool = False
    memory_key: str = ""

@app.post("/api/jobs/profile")
def create_profile_job(req: ProfileRequest, background_tasks: BackgroundTasks):
    job_id = str(uuid.uuid4())
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute("INSERT INTO jobs (id, job_type, status, created_at) VALUES (?, ?, ?, ?)",
                     (job_id, "profile", "running", datetime.now().isoformat()))

    background_tasks.add_task(run_job_task, job_id, "profile", req.memory_key or req.company_name_or_url,
                              agent.run_company_profile, get_client(), req.company_name_or_url, req.no_pdf)
    return {"job_id": job_id}

# ---------------------------------------------------------------------------
# RAG Agent
# ---------------------------------------------------------------------------

@app.get("/api/companies")
def list_companies():
    """All stored company knowledge stores, newest first."""
    return rag_agent.list_stores()

class AskRequest(BaseModel):
    company: str      # the memory_key the knowledge store was saved under
    question: str

@app.post("/api/ask")
def ask_company(req: AskRequest):
    """RAG answer about a company from its knowledge store."""
    if not req.question.strip():
        raise HTTPException(status_code=400, detail="Question is empty")
    try:
        return rag_agent.ask(get_client(), req.company, req.question.strip())
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Ask failed: {exc}")

@app.get("/api/jobs")
def list_jobs():
    with sqlite3.connect(DB_PATH) as conn:
        conn.row_factory = sqlite3.Row
        rows = conn.execute("SELECT * FROM jobs ORDER BY created_at DESC").fetchall()
        return [dict(row) for row in rows]

@app.get("/api/jobs/{job_id}")
def get_job(job_id: str):
    with sqlite3.connect(DB_PATH) as conn:
        conn.row_factory = sqlite3.Row
        row = conn.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Job not found")
        job_data = dict(row)
        if job_data["result_files"]:
            job_data["result_files"] = json.loads(job_data["result_files"])
        return job_data

@app.get("/api/jobs/{job_id}/log")
def get_job_log(job_id: str):
    log_path = LOGS_DIR / f"{job_id}.log"
    if not log_path.exists():
        return PlainTextResponse("Waiting for log output...", status_code=200)
    return PlainTextResponse(log_path.read_text(encoding="utf-8"), status_code=200)

@app.get("/api/download")
def download_file(path: str):
    base = agent.OUTPUT_DIR.resolve()
    try:
        target = Path(path).resolve()
    except (OSError, ValueError):
        raise HTTPException(status_code=400, detail="Invalid path")
    # Confine strictly to the output directory (resolves away any ../ traversal).
    if not target.is_relative_to(base):
        raise HTTPException(status_code=403, detail="Forbidden path")
    if not target.is_file():
        raise HTTPException(status_code=404, detail="File not found")
    return FileResponse(path=target, filename=target.name)
