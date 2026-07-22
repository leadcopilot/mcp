"""
RAG Agent — Per-Company Knowledge Stores
========================================

Every research job (report / leads / profile) feeds its outputs into a
per-company knowledge store: a JSON base of text chunks with Mistral
embeddings, saved in rag_store/<slug>.json.

Asking a question runs classic RAG against the store:
  1. embed the question (mistral-embed)
  2. retrieve the most similar chunks by cosine similarity
  3. answer with Mistral chat grounded ONLY in the retrieved chunks

If the embeddings API is unavailable (rate limit, outage), both ingestion
and retrieval degrade gracefully to keyword-overlap scoring, so the RAG
agent keeps working — just with cruder retrieval until embeddings succeed
again.
"""

from __future__ import annotations

import json
import math
import re
import threading
import time
import datetime as dt
from pathlib import Path
from typing import Optional

import main as agent

# --- Config ---
STORE_DIR = Path("rag_store")
EMBED_MODEL = "mistral-embed"
EMBED_BATCH_SIZE = 32          # inputs per embeddings call
EMBED_MAX_RETRIES = 3
EMBED_RETRY_DELAY = 4.0        # seconds; doubles each retry
CHUNK_CHARS = 1400             # target chunk size
CHUNK_OVERLAP = 200            # overlap between windows within a section
CSV_ROWS_PER_CHUNK = 12        # leads CSV rows grouped per chunk
TOP_K = 8                      # chunks retrieved per question
MAX_CONTEXT_CHARS = 14000      # cap on retrieved context sent to the LLM

# one lock is enough: stores are small and writes are rare (job completions)
_store_lock = threading.Lock()

ASK_SYSTEM_PROMPT = """You are a business-intelligence assistant answering
questions about a specific company using ONLY the provided research
knowledge base. Every claim must come from the context chunks below. Cite
the chunk you used inline as [#chunk-id]. If the knowledge base does not
contain the answer, say so plainly and suggest re-running research — never
invent facts, figures, competitor names, or URLs. Answer in clear, direct
business language; use markdown tables or bullet lists when they help."""


# ============================================================================
# STORE PERSISTENCE
# ============================================================================

def _store_path(company_key: str) -> Path:
    return STORE_DIR / f"{agent.slugify(company_key)}.json"


def _display_name(company_key: str) -> str:
    """Human name for a store: the domain for URLs, the text otherwise."""
    dom = agent.domain_of(company_key)
    return dom or company_key


def load_store(company_key: str) -> Optional[dict]:
    path = _store_path(company_key)
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None


def _save_store(store: dict) -> None:
    STORE_DIR.mkdir(parents=True, exist_ok=True)
    path = _store_path(store["company_key"])
    path.write_text(json.dumps(store, ensure_ascii=False), encoding="utf-8")


def list_stores() -> list[dict]:
    """Summaries of every stored company knowledge base (no chunk bodies)."""
    out = []
    for path in sorted(STORE_DIR.glob("*.json")):
        try:
            s = json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            continue
        chunks = s.get("chunks", [])
        out.append({
            "company_key": s.get("company_key", path.stem),
            "display_name": s.get("display_name", path.stem),
            "updated_at": s.get("updated_at", ""),
            "doc_types": sorted({c.get("doc_type", "?") for c in chunks}),
            "chunk_count": len(chunks),
            "embedded_count": sum(1 for c in chunks if c.get("embedding")),
        })
    out.sort(key=lambda s: s["updated_at"], reverse=True)
    return out


# ============================================================================
# CHUNKING
# ============================================================================

def chunk_markdown(text: str) -> list[str]:
    """Split a markdown document into chunks: by ## sections first, then by
    overlapping character windows within long sections. Each chunk keeps its
    section heading as context so retrieval stays meaningful."""
    sections: list[tuple[str, str]] = []  # (heading, body)
    current_head, current_lines = "", []
    for line in text.splitlines():
        if line.startswith("## "):
            if current_lines:
                sections.append((current_head, "\n".join(current_lines).strip()))
            current_head, current_lines = line.strip(), []
        else:
            current_lines.append(line)
    if current_lines:
        sections.append((current_head, "\n".join(current_lines).strip()))

    chunks: list[str] = []
    for head, body in sections:
        if not body:
            continue
        prefix = (head + "\n") if head else ""
        if len(body) <= CHUNK_CHARS:
            chunks.append(prefix + body)
            continue
        step = CHUNK_CHARS - CHUNK_OVERLAP
        for start in range(0, len(body), step):
            window = body[start:start + CHUNK_CHARS]
            if len(window) < 200 and chunks:  # tiny tail — skip
                break
            chunks.append(prefix + window)
    return chunks


def chunk_csv(text: str) -> list[str]:
    """Turn a leads CSV into chunks of CSV_ROWS_PER_CHUNK rows, each chunk
    repeating the header line so every chunk is self-describing."""
    lines = [l for l in text.splitlines() if l.strip()]
    if len(lines) < 2:
        return []
    header, rows = lines[0], lines[1:]
    chunks = []
    for i in range(0, len(rows), CSV_ROWS_PER_CHUNK):
        block = rows[i:i + CSV_ROWS_PER_CHUNK]
        chunks.append("Leads list (CSV excerpt):\n" + header + "\n" + "\n".join(block))
    return chunks


# ============================================================================
# EMBEDDINGS
# ============================================================================

def embed_texts(client, texts: list[str]) -> list[Optional[list[float]]]:
    """Embed texts in batches (Gemini embeddings — replaces paid Mistral). Failed
    batches yield None entries (keyword fallback covers them at query time) instead
    of failing ingestion. `client` is kept for signature compatibility (unused)."""
    from gemini_py import gemini_embed

    vectors: list[Optional[list[float]]] = []
    for start in range(0, len(texts), EMBED_BATCH_SIZE):
        batch = texts[start:start + EMBED_BATCH_SIZE]
        batch_vectors: Optional[list[list[float]]] = None
        for attempt in range(1, EMBED_MAX_RETRIES + 1):
            try:
                batch_vectors = gemini_embed(batch)
                break
            except Exception as exc:
                print(f"    ! embeddings call failed (attempt {attempt}/{EMBED_MAX_RETRIES}): {exc}")
                if attempt < EMBED_MAX_RETRIES:
                    time.sleep(EMBED_RETRY_DELAY * (2 ** (attempt - 1)))
        vectors.extend(batch_vectors if batch_vectors else [None] * len(batch))
        time.sleep(1.0)  # stay polite to the rate limit between batches
    return vectors


def _cosine(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    return dot / (na * nb) if na and nb else 0.0


def _keyword_score(question: str, text: str) -> float:
    """Crude retrieval fallback: fraction of question terms present in the
    chunk. Used when embeddings are missing for the question or a chunk."""
    q_tokens = {t for t in re.findall(r"[a-z0-9]{3,}", question.lower())}
    if not q_tokens:
        return 0.0
    t_lower = text.lower()
    return sum(1 for t in q_tokens if t in t_lower) / len(q_tokens)


# ============================================================================
# INGESTION
# ============================================================================

def ingest_job_outputs(client: agent.Mistral, company_key: str,
                       job_type: str, result_files: dict) -> int:
    """Feed a completed job's output files into the company's RAG store.
    Chunks are tagged with the job type; re-running the same job type for the
    same company replaces its old chunks (latest research wins).
    Returns the number of chunks added."""
    texts: list[str] = []
    sources: list[str] = []
    for kind, path_str in (result_files or {}).items():
        if not path_str or kind == "pdf":  # pdf duplicates the md content
            continue
        path = Path(path_str)
        if not path.exists():
            continue
        try:
            text = path.read_text(encoding="utf-8-sig")
        except OSError:
            continue
        parts = chunk_csv(text) if path.suffix == ".csv" else chunk_markdown(text)
        texts.extend(parts)
        sources.extend([path.name] * len(parts))

    if not texts:
        return 0

    print(f"  rag: embedding {len(texts)} chunks for {_display_name(company_key)!r}...")
    vectors = embed_texts(client, texts)
    embedded = sum(1 for v in vectors if v)
    print(f"  rag: {embedded}/{len(texts)} chunks embedded")

    now = dt.datetime.now().isoformat(timespec="seconds")
    with _store_lock:
        store = load_store(company_key) or {
            "company_key": company_key,
            "display_name": _display_name(company_key),
            "created_at": now,
            "chunks": [],
        }
        # latest research for this job type replaces the previous run's chunks
        store["chunks"] = [c for c in store["chunks"] if c.get("doc_type") != job_type]
        base_id = len(store["chunks"])
        for i, (text, src, vec) in enumerate(zip(texts, sources, vectors)):
            store["chunks"].append({
                "id": f"{job_type}-{base_id + i + 1}",
                "doc_type": job_type,
                "source_file": src,
                "text": text,
                "embedding": vec,
            })
        store["updated_at"] = now
        _save_store(store)

    print(f"  rag: knowledge store now holds {len(texts)} new + "
          f"{base_id} existing chunks")
    return len(texts)


# ============================================================================
# ASKING (RAG)
# ============================================================================

def retrieve(client: agent.Mistral, store: dict, question: str,
             top_k: int = TOP_K) -> list[dict]:
    """Rank the store's chunks against the question — cosine similarity when
    embeddings exist on both sides, keyword overlap otherwise."""
    chunks = store.get("chunks", [])
    if not chunks:
        return []

    q_vec: Optional[list[float]] = None
    if any(c.get("embedding") for c in chunks):
        vecs = embed_texts(client, [question])
        q_vec = vecs[0] if vecs else None

    scored = []
    for c in chunks:
        if q_vec and c.get("embedding"):
            score = _cosine(q_vec, c["embedding"])
        else:
            score = _keyword_score(question, c["text"])
        scored.append((score, c))
    scored.sort(key=lambda pair: pair[0], reverse=True)
    return [c for score, c in scored[:top_k] if score > 0]


def ask(client: agent.Mistral, company_key: str, question: str) -> dict:
    """Answer a question about a company from its RAG knowledge store.
    Returns {answer, chunks_used, company}."""
    store = load_store(company_key)
    if store is None:
        return {
            "answer": "No knowledge store exists for this company yet. "
                      "Run research on its URL first.",
            "chunks_used": [],
            "company": _display_name(company_key),
        }

    top = retrieve(client, store, question)
    if not top:
        return {
            "answer": "The knowledge store for this company has no content "
                      "matching the question. Try re-running research.",
            "chunks_used": [],
            "company": store.get("display_name", company_key),
        }

    blocks, total = [], 0
    used = []
    for c in top:
        block = f"[#{c['id']}] (from {c['source_file']})\n{c['text']}"
        if total + len(block) > MAX_CONTEXT_CHARS:
            break
        blocks.append(block)
        total += len(block)
        used.append({"id": c["id"], "doc_type": c["doc_type"], "source_file": c["source_file"]})

    user_prompt = f"""
COMPANY: {store.get('display_name', company_key)} ({store.get('company_key', '')})

RESEARCH KNOWLEDGE BASE (chunks, cite as [#chunk-id]):
{chr(10).join(blocks)}

QUESTION: {question}

Answer from the knowledge base above only.
""".strip()

    answer = agent.call_mistral(client, ASK_SYSTEM_PROMPT, user_prompt,
                                max_tokens=1500, temperature=0.2)
    return {
        "answer": answer,
        "chunks_used": used,
        "company": store.get("display_name", company_key),
    }
