"""
Python Gemini client for the deep-research sidecar — mirrors lib/ai/geminiClient.js
and the backend's gemini.py. REST generateContent with the x-goog-api-key header,
comma-separated GEMINI_API_KEYS rotated on 429/503, plus batch embeddings.
Replaces the paid Mistral dependency.
"""
import os
import time
import threading
import httpx

_lock = threading.Lock()
_key_idx = 0
_TIMEOUT = httpx.Timeout(180.0, connect=10.0)


def _base_url() -> str:
    return os.getenv("GEMINI_BASE_URL", "https://generativelanguage.googleapis.com/v1beta")


def _keys() -> list[str]:
    raw = os.getenv("GEMINI_API_KEYS") or os.getenv("GEMINI_API_KEY") or ""
    return [k.strip() for k in raw.split(",") if k.strip()]


def gemini_chat(system_prompt: str, user_prompt: str, max_tokens: int = 4000,
                temperature: float = 0.4, model: str | None = None) -> str:
    """Text generation with key rotation + backoff. Raises on hard failure."""
    keys = _keys()
    if not keys:
        raise RuntimeError("No GEMINI_API_KEYS configured")
    mdl = model or os.getenv("GEMINI_MODEL", "gemini-flash-latest")
    level = os.getenv("GEMINI_THINKING_LEVEL", "low")

    body: dict = {
        "contents": [{"role": "user", "parts": [{"text": user_prompt}]}],
        "systemInstruction": {"parts": [{"text": system_prompt}]},
        "generationConfig": {"temperature": temperature, "maxOutputTokens": max(int(max_tokens), 2048)},
    }
    if level:
        body["generationConfig"]["thinkingConfig"] = {"thinkingLevel": level}

    global _key_idx
    last_err = None
    attempts = max(len(keys) * 2, 4)
    url_tpl = f"{_base_url()}/models/{mdl}:generateContent"
    for attempt in range(attempts):
        with _lock:
            idx = _key_idx % len(keys)
            key = keys[idx]
        try:
            r = httpx.post(url_tpl, json=body, timeout=_TIMEOUT, headers={"x-goog-api-key": key})
        except Exception as exc:  # transient network
            last_err = exc
            with _lock:
                _key_idx = (idx + 1) % len(keys)
            time.sleep(1.5)
            continue
        if r.status_code in (429, 503):
            last_err = RuntimeError(f"Gemini {r.status_code}: {r.text[:120]}")
            with _lock:
                _key_idx = (idx + 1) % len(keys)
            time.sleep(min(2 ** attempt, 8))
            continue
        r.raise_for_status()
        data = r.json()
        cands = data.get("candidates") or []
        if not cands:
            raise RuntimeError(f"Gemini returned no candidates: {str(data)[:160]}")
        parts = (cands[0].get("content") or {}).get("parts") or []
        text = "".join(p.get("text", "") for p in parts
                       if isinstance(p, dict) and not p.get("thought")).strip()
        if not text:
            raise RuntimeError("Gemini returned empty content")
        return text
    raise RuntimeError(f"Gemini failed after {attempts} attempts: {last_err}")


EMBED_MODEL = os.getenv("GEMINI_EMBED_MODEL", "gemini-embedding-001")


def gemini_embed(texts: list[str]) -> list[list[float] | None]:
    """Embed each text via Gemini embedContent (the sync batch endpoint isn't
    offered for this model). Returns one vector per input."""
    keys = _keys()
    if not keys:
        raise RuntimeError("No GEMINI_API_KEYS configured")
    key = keys[0]
    url = f"{_base_url()}/models/{EMBED_MODEL}:embedContent"
    out: list[list[float] | None] = []
    for t in texts:
        body = {"model": f"models/{EMBED_MODEL}", "content": {"parts": [{"text": t}]}}
        r = httpx.post(url, json=body, timeout=_TIMEOUT, headers={"x-goog-api-key": key})
        r.raise_for_status()
        out.append(r.json().get("embedding", {}).get("values"))
    return out
