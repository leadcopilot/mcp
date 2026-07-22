"""
Business Intelligence Research Agent
=====================================

Takes a business topic as input, searches the web (DuckDuckGo), scrapes
clean article text from the results (trafilatura), and uses Mistral AI
(mistral-large-latest) to generate a professional 20-30 page business
analysis report as Markdown (+ optional PDF).

Usage:
    # Research report mode:
    python main.py "AI-powered personal finance apps for Gen Z"
    python main.py                      # will prompt for a topic
    python main.py "some topic" --no-pdf

    # Lead-finding mode: profile a company from its website, find its
    # competitors, and build a 100-200 row prospect/leads list (CSV + report):
    python main.py --leads https://yourcompany.com
    python main.py --leads https://yourcompany.com --audience "engineering colleges in India" --count 150

    # Company-profile mode: give a company NAME (or URL); the agent finds the
    # official website, scrapes it + the web, and writes a profile covering
    # Company Overview (incl. business model and market value), Key Services
    # & Offerings, and Top Competitors:
    python main.py --profile "Zomato"
    python main.py --profile https://www.zomato.com
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import ipaddress
import json
import re
import socket
import sys
import textwrap
import time
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional
from urllib.parse import urlparse

import httpx
from dotenv import load_dotenv
import os

try:
    from ddgs import DDGS  # current package name
except ImportError:
    from duckduckgo_search import DDGS  # older package name, still works

import trafilatura

# Mistral is no longer required (re-platformed to Gemini). Import kept optional
# only so any lingering type reference resolves; None when not installed.
try:
    from mistralai import Mistral  # noqa: F401
except ImportError:
    try:
        from mistralai.client import Mistral  # noqa: F401
    except ImportError:
        Mistral = None  # noqa: N816

# ============================================================================
# CONFIG — tune agent behavior here without touching the logic below
# ============================================================================

load_dotenv()

MISTRAL_API_KEY = os.getenv("MISTRAL_API_KEY", "")
MISTRAL_MODEL = "mistral-large-latest"

# Optional fallback LLM — used automatically only when a Mistral call has
# exhausted all its retries (rate limit, outage). Leave GROQ_API_KEY empty
# to disable the fallback entirely.
GROQ_API_KEY = os.getenv("GROQ_API_KEY", "")
# "qwen/qwen3.6-27b" is not a served Groq model id; default to a current one.
GROQ_MODEL = os.getenv("GROQ_MODEL", "llama-3.3-70b-versatile")
GROQ_CHAT_URL = "https://api.groq.com/openai/v1/chat/completions"
GROQ_MAX_RETRIES = 3

# --- Search ---
MAX_URLS = 30                      # total unique URLs to attempt to scrape
RESULTS_PER_QUERY = 4               # search results pulled per query template
SEARCH_REGION = "wt-wt"             # region code; wt-wt = no region bias
SEARCH_TIMELIMIT = None             # e.g. "y" for past year, None = no limit
# Which search engine(s) to use. The ddgs library is a metasearch tool:
# a comma-delimited list is tried in order, so the setting below asks
# Google first and falls back to Bing/Brave/DuckDuckGo when Google blocks
# scraping (which it frequently does). Use "auto" to rotate across every
# reachable engine instead, or a single name like "google" to force one.
SEARCH_BACKEND = "google, bing, brave, duckduckgo"

QUERY_TEMPLATES = [
    "{topic} market size and growth forecast",
    "{topic} industry trends {year}",
    "{topic} major companies competitors",
    "{topic} market share leaders",
    "{topic} customer segments target audience",
    "{topic} pricing business model revenue",
    "{topic} funding investment venture capital",
    "{topic} regulations compliance landscape",
    "{topic} technology innovation",
    "{topic} risks challenges outlook",
]

# --- Scraping ---
MIN_EXTRACT_CHARS = 200             # discard scraped pages shorter than this
SCRAPE_TIMEOUT_SECONDS = 15
MAX_WORKERS = 8                      # parallel scrape threads

# --- Source context sent to the LLM ---
MAX_CHARS_PER_SOURCE = 1800          # excerpt length per source in prompts
MAX_TOTAL_CONTEXT_CHARS = 45000      # ~11k token budget for source material/call

# --- Mistral call behavior ---
MAX_RETRIES = 5
BASE_RETRY_DELAY = 5.0               # seconds; doubles each retry (exponential backoff)
REQUEST_DELAY_SECONDS = 2.0          # pause between calls to respect free-tier rate limits
MAX_OUTPUT_TOKENS = 4500             # per-section generation cap

MIN_USABLE_SOURCES = 4               # warn (not abort) if fewer sources scrape cleanly

# --- Output ---
OUTPUT_DIR = Path("output")
GENERATE_PDF_DEFAULT = True

# --- Lead-finding mode ---
LEADS_TARGET_COUNT = 150             # default target size of the leads list
LEADS_MAX_COUNT = 200                # hard cap on the leads list
LEAD_QUERY_COUNT = 12                # search queries generated for lead hunting
LEAD_RESULTS_PER_QUERY = 6           # DDG results pulled per lead query
LEAD_MAX_URLS = 45                   # max candidate pages scraped for leads
COMPETITOR_MAX_URLS = 12             # max pages scraped for competitor analysis
LEAD_EXTRACT_CHUNK_CHARS = 9000      # page text fed per extraction call
LEAD_MAX_EXTRACT_CALLS = 35          # hard cap on extraction LLM calls
LEAD_ENRICH_MAX_FETCHES = 90         # extra page fetches to fill missing emails
LEAD_WEBSITE_LOOKUPS = 40            # DDG lookups to find websites of leads that lack one

# --- Company-profile mode ---
PROFILE_MAX_URLS = 18                # max web pages scraped about the company
PROFILE_RESULTS_PER_QUERY = 4        # DDG results pulled per profile query
PROFILE_SITE_PATHS = (               # official-site subpages worth scraping
    "", "/about", "/about-us", "/services", "/products", "/pricing",
)
PROFILE_QUERY_TEMPLATES = [
    "{company} company about services products",
    "{company} business model how does it make money",
    "{company} market value valuation market cap funding",
    "{company} annual revenue",
    "{company} competitors alternatives",
    "top competitors of {company}",
]

# --- Report structure — edit this list to change sections, order, or length.
# Word targets are calibrated so the full report lands at ~20-30 printed
# pages (~12,000-18,000 words) at roughly 600 words/page.
REPORT_SECTIONS = [
    {
        "key": "executive_summary",
        "title": "1. Executive Summary",
        "target_words": 900,
        "instructions": """
            Summarize the business opportunity in {topic}. Cover: the single
            most important finding, 3-5 key strategic recommendations, and an
            explicit market opportunity size (state a number/range, e.g.
            TAM/SAM, if the sources or a reasonable inference support it).
            Written for a busy executive — punchy, specific, no fluff.
        """,
    },
    {
        "key": "industry_overview",
        "title": "2. Industry Overview",
        "target_words": 1500,
        "instructions": """
            Cover current market size and growth rate (CAGR if available),
            the 3-5 most important trends reshaping the industry, and the
            regulatory landscape relevant to it. Cite specific figures from
            the sources wherever possible.
        """,
    },
    {
        "key": "competitive_landscape",
        "title": "3. Competitive Landscape",
        "target_words": 2100,
        "instructions": """
            Identify the major players/companies in this space. Include a
            markdown table comparing them (columns: Company, Positioning,
            Est. Market Share or Scale, Key Strength, Key Weakness). Follow
            with a competitive positioning discussion, then a SWOT analysis
            (Strengths, Weaknesses, Opportunities, Threats) for the top 3
            competitors, each as its own subsection with a small SWOT table.
        """,
    },
    {
        "key": "market_analysis",
        "title": "4. Market Analysis",
        "target_words": 2100,
        "instructions": """
            Define the target customer segments (with a segmentation table:
            Segment, Profile, Needs, Willingness to Pay). Detail customer
            needs and pain points backed by evidence from sources. Identify
            concrete market gaps and white-space opportunities a new
            entrant could exploit.
        """,
    },
    {
        "key": "financial_analysis",
        "title": "5. Financial Analysis",
        "target_words": 1500,
        "instructions": """
            Describe the dominant revenue models used in this space
            (subscription, transaction fee, marketplace take-rate, etc.) and
            typical pricing strategies, ideally with a pricing comparison
            table. Summarize the funding/investment landscape if applicable
            (notable raises, investor appetite). Give an overview of typical
            unit economics (CAC, LTV, margins) where inferable from sources,
            being explicit about which numbers are sourced vs. reasonable
            industry-standard estimates.
        """,
    },
    {
        "key": "technology_innovation",
        "title": "6. Technology & Innovation",
        "target_words": 1500,
        "instructions": """
            Explain the key technologies driving this market, current
            innovation trends, and where the market sits on the technology
            adoption curve (innovators / early adopters / early majority /
            late majority / laggards), with reasoning.
        """,
    },
    {
        "key": "risk_analysis",
        "title": "7. Risk Analysis",
        "target_words": 900,
        "instructions": """
            Lay out the major market risks, regulatory risks, and
            competitive threats. For each risk, give a concrete mitigation
            strategy. Use a risk table (Risk, Likelihood, Impact,
            Mitigation).
        """,
    },
    {
        "key": "strategic_recommendations",
        "title": "8. Strategic Recommendations",
        "target_words": 1500,
        "instructions": """
            Give specific, actionable go-to-market strategies, concrete
            partnership opportunities, ranked investment priorities, and a
            phased timeline with milestones (e.g. 0-6 months, 6-18 months,
            18-36 months). Avoid generic advice — every recommendation
            should be specific to {topic}.
        """,
    },
    {
        "key": "conclusion",
        "title": "9. Conclusion",
        "target_words": 600,
        "instructions": """
            Summarize the key insights from the report in a tight closing,
            and give one clear final recommendation (go / go-with-caveats /
            no-go, or the equivalent framing for this topic) with the single
            biggest reason why.
        """,
    },
]

SECTION_SYSTEM_PROMPT = """You are a senior management consultant at a top-tier
strategy firm (McKinsey/BCG caliber) writing a business analysis report.
Write in professional business language: precise, data-driven, and free of
generic filler. Whenever you state a fact that comes from the provided
sources, cite it inline immediately after the claim in the exact format
[Source: URL]. Use the exact URLs given in the source list — never invent a
URL. If no source supports a specific number, either omit the number or
clearly label it as an estimate/assumption. Use markdown tables where they
would help the reader compare options. The section heading is already
provided by the report template — do not repeat or restate the section
title as a heading of your own. Start directly with the content (you may
use ### subsections for distinct sub-topics within the section, but never
as the very first line)."""


# ============================================================================
# DATA MODEL
# ============================================================================

@dataclass
class Source:
    """A single successfully-scraped web source."""

    url: str
    title: str
    text: str
    word_count: int = field(init=False)

    def __post_init__(self) -> None:
        self.word_count = len(self.text.split())


# ============================================================================
# SEARCH
# ============================================================================

def build_search_queries(topic: str) -> list[str]:
    """Expand the report's query templates into concrete search queries for
    this topic, so the search phase covers every angle of the report."""
    year = dt.datetime.now().year
    return [t.format(topic=topic, year=year) for t in QUERY_TEMPLATES]


TAVILY_API_KEY = os.getenv("TAVILY_API_KEY", "")


def _tavily_search(query: str, count: int) -> list[str]:
    """Search via Tavily (reliable, keyed). Returns result URLs, or [] on any
    failure so the caller can fall back to DuckDuckGo."""
    if not TAVILY_API_KEY:
        return []
    try:
        resp = httpx.post(
            "https://api.tavily.com/search",
            json={
                "api_key": TAVILY_API_KEY,
                "query": query,
                "search_depth": "advanced",
                "max_results": count,
            },
            timeout=20.0,
        )
        resp.raise_for_status()
        return [r["url"] for r in resp.json().get("results", []) if r.get("url")]
    except Exception as exc:
        print(f"    ! tavily failed for {query!r}: {exc}")
        return []


def _ddg_search(ddgs, query: str, count: int) -> list[str]:
    """DuckDuckGo fallback search. Returns result URLs, or [] on failure."""
    try:
        try:
            results = ddgs.text(
                query, region=SEARCH_REGION, timelimit=SEARCH_TIMELIMIT,
                backend=SEARCH_BACKEND, max_results=count,
            )
        except TypeError:
            results = ddgs.text(query, max_results=count)
    except Exception as exc:
        print(f"    ! ddg failed for {query!r}: {exc}")
        return []
    return [r.get("href") or r.get("url") or r.get("link") for r in (results or [])]


def run_searches(queries: list[str], results_per_query: int, max_urls: int) -> list[str]:
    """Run each query through Tavily first (reliable), falling back to
    DuckDuckGo only when Tavily is unavailable/empty. Deduped, capped at
    max_urls. Individual query failures are skipped."""
    seen: set[str] = set()
    urls: list[str] = []

    with DDGS() as ddgs:
        for i, query in enumerate(queries, 1):
            if len(urls) >= max_urls:
                break
            engine = "tavily" if TAVILY_API_KEY else "ddg"
            print(f"  [{i}/{len(queries)}] searching ({engine}): {query!r}")

            found = _tavily_search(query, results_per_query)
            if not found:  # no key, or Tavily returned nothing/errored
                found = _ddg_search(ddgs, query, results_per_query)
                if TAVILY_API_KEY:
                    time.sleep(1.0)  # be gentle with DDG when used as fallback

            for url in found:
                if not url or url in seen:
                    continue
                seen.add(url)
                urls.append(url)
                if len(urls) >= max_urls:
                    break

    return urls


def search_web(topic: str, max_urls: int = MAX_URLS) -> list[str]:
    """Run DuckDuckGo searches across several query angles for the research
    report and return a deduplicated URL list, capped at max_urls."""
    return run_searches(build_search_queries(topic), RESULTS_PER_QUERY, max_urls)


# ============================================================================
# SCRAPING
# ============================================================================

def is_public_url(url: str) -> bool:
    """SSRF guard: only allow http(s) URLs whose host resolves to public IPs.
    Blocks localhost, private/loopback/link-local ranges (incl. cloud metadata
    at 169.254.169.254) so a caller/search-derived URL can't reach internals."""
    try:
        parsed = urlparse(url)
    except Exception:
        return False
    if parsed.scheme not in ("http", "https"):
        return False
    host = (parsed.hostname or "").lower()
    if not host or host == "localhost" or host.endswith((".local", ".internal", ".localhost")):
        return False
    try:
        infos = socket.getaddrinfo(host, None)
    except Exception:
        return False
    for info in infos:
        try:
            addr = ipaddress.ip_address(info[4][0])
        except ValueError:
            return False
        if (addr.is_private or addr.is_loopback or addr.is_link_local
                or addr.is_reserved or addr.is_multicast or addr.is_unspecified):
            return False
    return True


def scrape_url(url: str) -> Optional[Source]:
    """Download and extract clean article text from a URL using trafilatura.
    Returns None if the page can't be fetched or yields too little text."""
    if not is_public_url(url):
        return None
    try:
        downloaded = trafilatura.fetch_url(url)
    except Exception:
        downloaded = None

    if not downloaded:
        return None

    try:
        text = trafilatura.extract(
            downloaded,
            include_comments=False,
            include_tables=True,
            favor_precision=True,
        )
    except Exception:
        text = None

    if not text or len(text) < MIN_EXTRACT_CHARS:
        return None

    title = url
    try:
        metadata = trafilatura.extract_metadata(downloaded)
        if metadata and metadata.title:
            title = metadata.title
    except Exception:
        pass

    return Source(url=url, title=title, text=text.strip())


def scrape_all(urls: list[str]) -> list[Source]:
    """Scrape a list of URLs in parallel, skipping any that fail or time out."""
    sources: list[Source] = []
    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
        future_to_url = {pool.submit(scrape_url, url): url for url in urls}
        for i, future in enumerate(as_completed(future_to_url), 1):
            url = future_to_url[future]
            try:
                source = future.result(timeout=SCRAPE_TIMEOUT_SECONDS)
            except Exception:
                source = None

            if source:
                print(f"  [{i}/{len(urls)}] ok    {url}  ({source.word_count} words)")
                sources.append(source)
            else:
                print(f"  [{i}/{len(urls)}] skip  {url}")

    return sources


# ============================================================================
# TOKEN / CONTEXT HELPERS
# ============================================================================

def estimate_tokens(text: str) -> int:
    """Rough token estimate (~4 chars/token). Avoids adding a tokenizer
    dependency; precise enough to keep prompts within Mistral's context."""
    return max(1, len(text) // 4)


def format_source_context(
    sources: list[Source],
    max_chars_per_source: int = MAX_CHARS_PER_SOURCE,
    max_total_chars: int = MAX_TOTAL_CONTEXT_CHARS,
) -> str:
    """Build a numbered block of source excerpts for LLM prompts, truncating
    individual sources and the overall total to stay within a safe token
    budget for every section-generation call."""
    blocks = []
    total = 0
    for i, src in enumerate(sources, 1):
        excerpt = src.text[:max_chars_per_source]
        block = f"[{i}] {src.title}\nURL: {src.url}\n{excerpt}\n"
        if total + len(block) > max_total_chars:
            break
        blocks.append(block)
        total += len(block)
    return "\n---\n".join(blocks)


# ============================================================================
# MISTRAL CALLS
# ============================================================================

def call_groq(
    system_prompt: str,
    user_prompt: str,
    max_tokens: int,
    temperature: float,
) -> str:
    """Call the Groq chat API (OpenAI-compatible) — the automatic fallback
    LLM when Mistral is unavailable. Requires GROQ_API_KEY."""
    resp = httpx.post(
        GROQ_CHAT_URL,
        headers={
            "Authorization": f"Bearer {GROQ_API_KEY}",
            "Content-Type": "application/json",
            "User-Agent": "Mozilla/5.0",  # Groq rejects default python user-agents
        },
        json={
            "model": GROQ_MODEL,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            "max_tokens": max_tokens,
            "temperature": temperature,
        },
        timeout=180,
    )
    resp.raise_for_status()
    content = resp.json()["choices"][0]["message"]["content"] or ""
    # Qwen reasoning models can emit <think>...</think> traces — strip them
    return re.sub(r"<think>.*?</think>", "", content, flags=re.DOTALL).strip()


def call_mistral(
    client,  # kept for signature compatibility; unused (Gemini needs no client object)
    system_prompt: str,
    user_prompt: str,
    max_tokens: int = MAX_OUTPUT_TOKENS,
    temperature: float = 0.4,
) -> str:
    """LLM call — Gemini first (free, key-rotated), Groq as automatic fallback.
    Re-platformed off the paid Mistral dependency; name kept so call sites are
    unchanged."""
    from gemini_py import gemini_chat

    try:
        result = gemini_chat(system_prompt, user_prompt, max_tokens=max_tokens, temperature=temperature)
        time.sleep(REQUEST_DELAY_SECONDS)
        return result
    except Exception as exc:
        print(f"    ! Gemini call failed: {exc}")
        if not GROQ_API_KEY:
            raise RuntimeError(f"Gemini failed and no GROQ_API_KEY fallback set: {exc}")

    print(f"    ! Falling back to Groq ({GROQ_MODEL})")
    last_error: Optional[Exception] = None
    for attempt in range(1, GROQ_MAX_RETRIES + 1):
        try:
            result = call_groq(system_prompt, user_prompt, max_tokens, temperature)
            time.sleep(REQUEST_DELAY_SECONDS)
            return result
        except Exception as exc:
            last_error = exc
            print(f"    ! Groq fallback failed (attempt {attempt}/{GROQ_MAX_RETRIES}): {exc}")
            if attempt < GROQ_MAX_RETRIES:
                time.sleep(BASE_RETRY_DELAY * (2 ** (attempt - 1)))

    raise RuntimeError(f"All LLM calls failed (Gemini + Groq): {last_error}")


def generate_section(
    client: Mistral,
    topic: str,
    section: dict,
    source_context: str,
    prior_titles: list[str],
) -> str:
    """Generate a single report section via Mistral, grounded in the scraped
    source context and aware of which sections were already written."""
    instructions = textwrap.dedent(section["instructions"]).format(topic=topic).strip()
    prior = ", ".join(prior_titles) if prior_titles else "none yet"

    if source_context:
        source_block = source_context
    else:
        source_block = (
            "(No web sources were retrieved successfully. Clearly note that "
            "any figures below are general industry knowledge/estimates, not "
            "sourced data, and avoid inventing specific statistics or citations.)"
        )

    user_prompt = f"""
BUSINESS TOPIC: {topic}

SECTION TO WRITE: {section['title']}
TARGET LENGTH: approximately {section['target_words']} words

SECTION INSTRUCTIONS:
{instructions}

SECTIONS ALREADY WRITTEN (avoid duplicating their content): {prior}

SOURCE MATERIAL (numbered; cite by URL as [Source: URL]):
{source_block}

Write the section now in markdown.
""".strip()

    print(f"  -> generating: {section['title']} (~{section['target_words']} words)")
    start = time.time()
    content = call_mistral(client, SECTION_SYSTEM_PROMPT, user_prompt, max_tokens=MAX_OUTPUT_TOKENS)
    elapsed = time.time() - start
    words = len(content.split())
    print(f"     done in {elapsed:.1f}s ({words} words)")
    return content


# ============================================================================
# REPORT ASSEMBLY
# ============================================================================

def build_sources_section(sources: list[Source]) -> str:
    """Build the final numbered 'Sources & References' section."""
    lines = ["## 10. Sources & References", ""]
    if not sources:
        lines.append("No web sources were successfully retrieved for this report.")
    else:
        for i, src in enumerate(sources, 1):
            title = src.title.replace("\n", " ").strip()
            lines.append(f"{i}. [{title}]({src.url}) — {src.url}")
    return "\n".join(lines)


def assemble_report(topic: str, section_contents: dict[str, str], sources: list[Source]) -> str:
    """Stitch generated sections + sources list into the final markdown report."""
    generated_at = dt.datetime.now().strftime("%Y-%m-%d %H:%M")
    header = textwrap.dedent(f"""
        # Business Intelligence Report: {topic}

        *Generated {generated_at} · {len(sources)} web sources analyzed · Powered by Mistral AI ({MISTRAL_MODEL})*

        ---
    """).strip()

    body_parts = [header, ""]
    for section in REPORT_SECTIONS:
        body_parts.append(f"## {section['title']}")
        body_parts.append("")
        body_parts.append(section_contents[section["key"]])
        body_parts.append("")

    body_parts.append(build_sources_section(sources))

    return "\n".join(body_parts)


# ============================================================================
# OUTPUT (Markdown + optional PDF)
# ============================================================================

def slugify(text: str) -> str:
    """Turn a topic string into a filesystem-safe slug for filenames."""
    slug = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    return slug[:60] or "report"


def unique_stamp() -> str:
    """Timestamp plus a short random suffix, so jobs running in parallel
    (multiple UI tabs/users) can never overwrite each other's files."""
    return f"{dt.datetime.now():%Y%m%d-%H%M%S}-{uuid.uuid4().hex[:4]}"


def save_markdown(content: str, topic: str, prefix: str = "report") -> Path:
    """Write the report to output/<prefix>_<slug>_<stamp>.md."""
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    path = OUTPUT_DIR / f"{prefix}_{slugify(topic)}_{unique_stamp()}.md"
    path.write_text(content, encoding="utf-8")
    return path


def convert_to_pdf(markdown_path: Path) -> Optional[Path]:
    """Convert the generated markdown report to PDF using xhtml2pdf (pure
    Python, no external binaries needed). Returns None and prints a warning
    if the optional PDF dependencies aren't installed, rather than failing
    the whole run."""
    try:
        import markdown as md
        from xhtml2pdf import pisa
    except ImportError:
        print("  ! PDF export skipped - install 'markdown' and 'xhtml2pdf' (see requirements.txt)")
        return None

    html_body = md.markdown(
        markdown_path.read_text(encoding="utf-8"),
        extensions=["tables", "fenced_code"],
    )
    html = f"""<html><head><meta charset="utf-8"><style>
        body {{ font-family: Helvetica, Arial, sans-serif; font-size: 11pt; line-height: 1.5; }}
        h1 {{ font-size: 20pt; }}
        h2 {{ font-size: 15pt; margin-top: 24px; }}
        h3 {{ font-size: 12.5pt; }}
        table {{ border-collapse: collapse; width: 100%; margin: 12px 0; }}
        th, td {{ border: 1px solid #999; padding: 6px 8px; font-size: 9.5pt; text-align: left; }}
        th {{ background-color: #eee; }}
    </style></head><body>{html_body}</body></html>"""

    pdf_path = markdown_path.with_suffix(".pdf")
    with open(pdf_path, "wb") as f:
        result = pisa.CreatePDF(html, dest=f)

    if result.err:
        print("  ! PDF conversion reported errors - the markdown file is still available")
        return None

    return pdf_path


# ============================================================================
# LEAD-FINDING MODE
# ============================================================================

EXTRACT_SYSTEM_PROMPT = """You are a precise data-extraction engine. You reply
with STRICT JSON only — no prose, no explanations, no markdown code fences.
You never invent data: every value you output must appear in, or be directly
inferable from, the provided text. Use null for anything unknown."""

# TLD must be alphabetic: rejects JS-asset strings like "splide@4.1.4"
EMAIL_RE = re.compile(r"[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}")
TEL_RE = re.compile(r"tel:([+\d][\d\-\s().]{6,})")
JUNK_EMAIL_PARTS = (
    ".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp",
    "example.", "sentry", "wixpress", "@2x", "domain.com",
    "email.com", "yourdomain", "your-email", "*", ".min.",
    "company.com", "yourcompany", "acme.",
)
JUNK_EMAIL_SUFFIXES = (".js", ".mjs", ".css", ".map", ".json", ".ts", ".html")

LEAD_FIELDS = ["name", "website", "email", "phone", "location", "notes", "source_url"]


def parse_json_loose(text: str):
    """Parse JSON out of an LLM reply, tolerating code fences and
    surrounding prose. Returns None if nothing parseable is found."""
    text = text.strip()
    text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text)
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass

    # fall back to the outermost bracket pair, whichever comes first
    starts = [(text.find(c), c, close) for c, close in (("[", "]"), ("{", "}")) if text.find(c) != -1]
    for _, open_c, close_c in sorted(starts):
        start, end = text.find(open_c), text.rfind(close_c)
        if end > start:
            try:
                return json.loads(text[start:end + 1])
            except json.JSONDecodeError:
                continue
    return None


def domain_of(url: str) -> str:
    """Extract a normalized (lowercase, no www.) domain from a URL-ish string."""
    if not url:
        return ""
    if "://" not in url:
        url = "http://" + url
    try:
        dom = urlparse(url).netloc.lower()
    except ValueError:
        return ""
    return dom.removeprefix("www.")


def clean_emails(candidates: list[str]) -> list[str]:
    """Deduplicate and filter obviously-bogus email candidates (asset
    filenames, placeholder domains, tracker addresses)."""
    out: list[str] = []
    seen: set[str] = set()
    for e in candidates:
        e = e.strip().strip(".").lower()
        if not e or e in seen or any(junk in e for junk in JUNK_EMAIL_PARTS):
            continue
        if e.endswith(JUNK_EMAIL_SUFFIXES) or not EMAIL_RE.fullmatch(e):
            continue
        seen.add(e)
        out.append(e)
    return out


def fetch_raw_html(url: str) -> Optional[str]:
    """Fetch a page's raw HTML (mailto:/tel: links live here, not in the
    extracted text). Returns None on any failure."""
    if not is_public_url(url):
        return None
    try:
        return trafilatura.fetch_url(url)
    except Exception:
        return None


def profile_company(client: Mistral, company_url: str, audience: str) -> dict:
    """Scrape the company's website and have Mistral produce a structured
    profile: what they do, who their ideal customers are, and what search
    terms will find competitors and leads."""
    print(f"  scraping company site: {company_url}")
    src = scrape_url(company_url)
    if src is None:
        print(f"ERROR: could not scrape {company_url} — check the URL is reachable.")
        sys.exit(1)

    audience_note = (
        f"USER-SPECIFIED TARGET AUDIENCE FOR LEADS: {audience}\n" if audience else ""
    )
    prompt = f"""
Analyze this company's website content and describe their business.

WEBSITE: {company_url}
{audience_note}WEBSITE CONTENT:
{src.text[:8000]}

Return STRICT JSON with exactly these keys:
{{
  "company_name": "official company name",
  "company_location": "the company's home city and region, e.g. 'Bengaluru, Karnataka, India' — from addresses, contact pages, or context in the content; empty string if truly undeterminable",
  "what_they_do": "1-2 sentence plain-language description",
  "products_services": ["list of main products/services"],
  "ideal_customer_profile": "who buys this, in one sentence",
  "lead_entity_type": "the type of organization to collect as sales leads, e.g. 'engineering colleges in India' or 'independent dental clinics in the US'",
  "lead_search_keywords": ["5-8 short search keyword phrases for finding such organizations"],
  "competitor_search_terms": ["3-5 search phrases to find this company's competitors"]
}}
If a user-specified target audience is given above, lead_entity_type and
lead_search_keywords MUST target that audience.
""".strip()

    for attempt in (1, 2):
        reply = call_mistral(client, EXTRACT_SYSTEM_PROMPT, prompt, max_tokens=1000, temperature=0.2)
        profile = parse_json_loose(reply)
        if isinstance(profile, dict) and profile.get("company_name"):
            profile["company_url"] = company_url
            return profile
        print(f"    ! could not parse company profile (attempt {attempt}/2), retrying...")

    print("ERROR: Mistral did not return a usable company profile. Try again or a different URL.")
    sys.exit(1)


def find_competitors(client: Mistral, profile: dict, location: str = "") -> tuple[str, list[Source]]:
    """Search for and analyze the company's competitors. Returns a markdown
    'Competitor Landscape' section and the sources it was built from.
    When a location is known, the analysis targets local/regional competitors
    of comparable size rather than global giants."""
    name = profile.get("company_name", "")
    terms = profile.get("competitor_search_terms") or []
    loc = location or profile.get("company_location", "")

    queries = [f"{name} competitors", f"{name} alternatives"]
    if loc:
        city = loc.split(",")[0].strip()
        queries += [f"{t} companies in {city}" for t in terms[:2]]
        queries += [f"small {t} agencies near {city}" for t in terms[:1]]
    else:
        queries += [f"top {t} companies" for t in terms[:3]]

    urls = run_searches(queries, results_per_query=5, max_urls=COMPETITOR_MAX_URLS)
    sources = scrape_all(urls)
    context = format_source_context(sources, max_total_chars=30000)

    local_rule = f"""
FOCUS ON LOCAL COMPETITORS: {name} is based in {loc}. Prioritize competitors
operating in or near {loc} that are of comparable (small-to-medium) size —
the local firms this company actually loses deals to. Do NOT fill the table
with multinational giants (e.g. IBM, Accenture, TCS, Infosys) unless the
sources clearly show them competing for the same local customers; at most 2
such large players, clearly marked as "(large national/global player)".
""" if loc else ""

    user_prompt = f"""
COMPANY BEING ANALYZED: {name} ({profile.get('company_url', '')})
WHAT THEY DO: {profile.get('what_they_do', '')}
{local_rule}
SOURCE MATERIAL:
{context if context else '(no sources scraped — rely on well-known companies in this space only, and say so)'}

Write a markdown "Competitor Landscape" analysis for {name}:
1. A table of 8-15 direct and indirect competitors with columns:
   Competitor | Website | Location | Positioning | Key Strength | Key Weakness
2. A short paragraph on how {name} is positioned relative to them.
Cite sources inline as [Source: URL] where the sources support a claim.
Only include competitors named in the sources or genuinely well-known in
this space — never invent company names or websites. Do not add a top-level
heading; start directly with the content.
""".strip()

    print("  -> analyzing competitors via Mistral...")
    md = call_mistral(client, SECTION_SYSTEM_PROMPT, user_prompt, max_tokens=2500)
    return md, sources


def generate_lead_queries(client: Mistral, profile: dict, audience: str,
                          location: str = "", radius_km: int = 80) -> list[str]:
    """Have Mistral generate diverse search queries aimed at finding lists
    and directories of the target lead organizations, with contact details.
    When a location is known, queries target small local businesses in and
    around that area (roughly radius_km) instead of national rankings."""
    target = audience or profile.get("lead_entity_type", "")
    keywords = profile.get("lead_search_keywords") or []
    loc = location or profile.get("company_location", "")

    local_rule = f"""
GEOGRAPHIC FOCUS — THIS IS CRITICAL: the leads must be located in and around
{loc}, within roughly {radius_km} km (the city itself plus its suburbs and
nearby towns). Every query MUST name {loc.split(',')[0].strip()} or a nearby
area. Use local-directory patterns like "<business type> in <city> contact
details", "<business type> <city> phone email address", "<city> <business
type> directory", including local listing sites (e.g. Justdial, Sulekha,
IndiaMART for India; Yelp/Yellow Pages elsewhere).
""" if loc else ""

    prompt = f"""
TARGET LEAD ORGANIZATIONS: {target}
CONTEXT: these organizations are potential CUSTOMERS for {profile.get('company_name', '')},
which does: {profile.get('what_they_do', '')}
USEFUL KEYWORDS: {', '.join(keywords)}
{local_rule}
Generate {LEAD_QUERY_COUNT} diverse web search queries to find LISTS and
DIRECTORIES of such organizations, ideally pages that include contact
details (emails, phone numbers). Target SMALL AND MEDIUM local businesses —
the kind that can actually be called and sold to. NEVER generate queries
like "top X companies" or "best X software" — those return rankings of
large famous companies, which are useless as leads.
Return a STRICT JSON array of {LEAD_QUERY_COUNT} strings.
""".strip()

    reply = call_mistral(client, EXTRACT_SYSTEM_PROMPT, prompt, max_tokens=800, temperature=0.5)
    queries = parse_json_loose(reply)
    if isinstance(queries, list) and queries:
        return [str(q) for q in queries if str(q).strip()][:LEAD_QUERY_COUNT]

    # fallback: build queries mechanically from the profile keywords
    print("    ! could not parse generated queries, falling back to keyword templates")
    base = [target] + keywords
    city = loc.split(",")[0].strip() if loc else ""
    if city:
        return [f"{kw} in {city} with contact details" for kw in base if kw][:LEAD_QUERY_COUNT]
    return [f"list of {kw} with contact details" for kw in base if kw][:LEAD_QUERY_COUNT]


def _clean_lead(item: object, company_dom: str) -> Optional[dict]:
    """Validate and normalize one extracted lead dict; None if unusable or
    if it points back at the company itself."""
    if not isinstance(item, dict):
        return None
    name = str(item.get("name") or "").strip()
    if not name or len(name) > 120:
        return None

    lead = {}
    for k in ("name", "website", "email", "phone", "location", "notes"):
        v = item.get(k)
        lead[k] = "" if v in (None, "", "null", "None") else str(v).strip()

    # data-broker pages mask contacts like "in**@bi**********" — worthless
    for k in ("website", "email", "phone"):
        if "*" in lead[k]:
            lead[k] = ""

    if company_dom and domain_of(lead["website"]) == company_dom:
        return None

    emails = clean_emails([lead["email"]]) if lead["email"] else []
    lead["email"] = emails[0] if emails else ""
    return lead


def _lead_key(lead: dict) -> str:
    """Dedup key for a lead: email > website domain > normalized name."""
    if lead.get("email"):
        return "e:" + lead["email"].lower()
    dom = domain_of(lead.get("website", ""))
    if dom:
        return "w:" + dom
    return "n:" + re.sub(r"[^a-z0-9]+", "", lead["name"].lower())


def _merge_lead_fields(existing: dict, other: dict) -> None:
    """Fill in fields the existing lead is missing from a duplicate copy."""
    for k in ("website", "email", "phone", "location", "notes"):
        if not existing.get(k) and other.get(k):
            existing[k] = other[k]


def dedupe_leads(leads: list[dict]) -> list[dict]:
    """Merge duplicate leads. Needed again after website/email lookups, since
    freshly-filled fields can reveal duplicates the extraction-time dedup
    (which keyed on incomplete data) couldn't see."""
    by_key: dict[str, dict] = {}
    for lead in leads:
        key = _lead_key(lead)
        if key in by_key:
            _merge_lead_fields(by_key[key], lead)
        else:
            by_key[key] = lead
    return list(by_key.values())


def extract_leads_from_source(
    client: Mistral, profile: dict, audience: str, source: Source,
    location: str = "", radius_km: int = 80,
) -> list[dict]:
    """Extract structured leads matching the target profile from one scraped
    page via Mistral. Returns a list of cleaned lead dicts (possibly empty).
    Enforces small-local-business criteria: no big brands, no competitors."""
    target = audience or profile.get("lead_entity_type", "")
    loc = location or profile.get("company_location", "")

    geo_rule = f"""
- GEOGRAPHY: only organizations located in or around {loc} (within roughly
  {radius_km} km — the city, its suburbs, and nearby towns). Exclude anything
  clearly based elsewhere or with no stated connection to this area.""" if loc else """
- STRICTLY respect any geographic constraint in the target profile — exclude
  organizations outside that geography."""

    prompt = f"""
TARGET LEAD PROFILE: {target}
CONTEXT: these leads are potential CUSTOMERS for {profile.get('company_name', '')},
which does: {profile.get('what_they_do', '')}

PAGE URL: {source.url}
PAGE CONTENT:
{source.text[:LEAD_EXTRACT_CHUNK_CHARS]}

Extract every distinct organization in the page content that could be a
realistic sales lead. Return a STRICT JSON array; each item:
{{"name": str, "website": str|null, "email": str|null, "phone": str|null, "location": str|null, "notes": str|null}}
Rules:
- Only organizations actually named in the content.{geo_rule}
- SIZE: only small and medium businesses that a sales rep could realistically
  call and close. EXCLUDE large national/multinational companies, famous
  brands, publicly listed corporations, and well-known SaaS platforms.
- CUSTOMERS ONLY: leads must be organizations that would BUY from
  {profile.get('company_name', '')} — EXCLUDE its competitors, i.e. companies
  selling the same kind of services it sells, and EXCLUDE
  {profile.get('company_name', '')} itself.
- Pages ranking "top/best companies or software" are competitor lists, not
  lead lists — extract from them ONLY organizations that genuinely fit the
  customer profile above, which is usually none.
- Include the organization's own website whenever it appears in the content;
  never invent emails, phones, or websites.
- notes = one short phrase on why they fit or what the page says about them.
If none match, return [].
""".strip()

    reply = call_mistral(client, EXTRACT_SYSTEM_PROMPT, prompt, max_tokens=3000, temperature=0.2)
    data = parse_json_loose(reply)
    if not isinstance(data, list):
        return []

    company_dom = domain_of(profile.get("company_url", ""))
    leads = []
    for item in data:
        lead = _clean_lead(item, company_dom)
        if lead:
            lead["source_url"] = source.url
            leads.append(lead)
    return leads


AGGREGATOR_DOMAINS = {
    "wikipedia.org", "facebook.com", "linkedin.com", "instagram.com",
    "tripadvisor.com", "yelp.com", "youtube.com", "twitter.com", "x.com",
    "crunchbase.com", "tracxn.com", "g2.com", "capterra.com", "reddit.com",
}


def _is_aggregator(url: str) -> bool:
    """True if the URL belongs to a directory/social site rather than an
    organization's own website."""
    dom = domain_of(url)
    return any(dom == a or dom.endswith("." + a) for a in AGGREGATOR_DOMAINS)


def _name_matches_domain(name: str, url: str) -> bool:
    """Heuristic guard against attaching the wrong website to a lead: some
    token of the lead's name must appear in the result's domain."""
    dom = domain_of(url)
    tokens = [t for t in re.split(r"[^a-z0-9]+", name.lower()) if len(t) >= 4]
    if not tokens:
        tokens = [t for t in re.split(r"[^a-z0-9]+", name.lower()) if len(t) >= 3]
    return any(t in dom for t in tokens)


def find_missing_websites(
    leads: list[dict], target: str, max_lookups: int = LEAD_WEBSITE_LOOKUPS
) -> int:
    """For leads without a website (common when extracted from list articles
    like Wikipedia), look up their official site via one DDG query each,
    within a budget. A result is only accepted if the lead's name plausibly
    matches the domain. Returns how many websites were found."""
    candidates = [l for l in leads if not l.get("website")][:max_lookups]
    if not candidates:
        return 0

    found = 0
    with DDGS() as ddgs:
        for lead in candidates:
            query = f"{lead['name']} {lead.get('location', '')} {target} official website".strip()
            try:
                try:
                    results = ddgs.text(query, backend=SEARCH_BACKEND, max_results=5)
                except TypeError:
                    results = ddgs.text(query, max_results=5)
            except Exception:
                break  # search engines are throttling — stop burning the budget
            for r in results or []:
                url = r.get("href") or r.get("url") or r.get("link")
                if (url and domain_of(url) and not _is_aggregator(url)
                        and _name_matches_domain(lead["name"], url)):
                    lead["website"] = url
                    found += 1
                    break
            time.sleep(1.0)
    return found


def _enrich_one_lead(lead: dict) -> bool:
    """Try to fill a lead's missing email (and phone) by fetching its website
    and common contact pages, then regexing mailto/tel targets from the raw
    HTML. Returns True if an email was found."""
    website = (lead.get("website") or "").strip()
    if not website:
        return False
    base = website if website.startswith(("http://", "https://")) else "https://" + website
    base = base.rstrip("/")

    for path in ("", "/contact", "/contact-us"):
        html = fetch_raw_html(base + path)
        if not html:
            continue
        emails = clean_emails(EMAIL_RE.findall(html))
        if emails:
            lead["email"] = emails[0]
            if not lead.get("phone"):
                tel = TEL_RE.search(html)
                if tel:
                    lead["phone"] = tel.group(1).strip()
            return True
    return False


def enrich_leads(leads: list[dict]) -> int:
    """Visit the websites of leads that lack an email (within a fetch budget)
    to pull publicly listed contact details. Returns how many were filled."""
    candidates = [l for l in leads if not l.get("email") and l.get("website")]
    candidates = candidates[: LEAD_ENRICH_MAX_FETCHES // 3]  # each tries up to 3 pages
    if not candidates:
        return 0

    found = 0
    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
        futures = {pool.submit(_enrich_one_lead, lead): lead for lead in candidates}
        for future in as_completed(futures):
            try:
                if future.result():
                    found += 1
            except Exception:
                pass
    return found


def save_leads_csv(leads: list[dict], company_name: str) -> Path:
    """Write the leads list to output/leads_<slug>_<stamp>.csv
    (utf-8-sig so Excel opens it cleanly)."""
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    path = OUTPUT_DIR / f"leads_{slugify(company_name)}_{unique_stamp()}.csv"
    with open(path, "w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=LEAD_FIELDS)
        writer.writeheader()
        for lead in leads:
            writer.writerow({k: lead.get(k, "") for k in LEAD_FIELDS})
    return path


def leads_to_markdown_table(leads: list[dict]) -> str:
    """Render the leads list as a markdown table."""
    header = (
        "| # | Name | Website | Email | Phone | Location | Notes |\n"
        "|---|------|---------|-------|-------|----------|-------|"
    )
    rows = []
    for i, lead in enumerate(leads, 1):
        cells = [str(i)] + [
            (lead.get(k) or "—").replace("|", "/").replace("\n", " ")
            for k in ("name", "website", "email", "phone", "location", "notes")
        ]
        rows.append("| " + " | ".join(cells) + " |")
    return "\n".join([header] + rows)


def build_leads_report(
    profile: dict,
    audience: str,
    competitor_md: str,
    leads: list[dict],
    lead_sources: list[Source],
) -> str:
    """Assemble the lead-generation markdown report."""
    generated_at = dt.datetime.now().strftime("%Y-%m-%d %H:%M")
    name = profile.get("company_name", "")
    target = audience or profile.get("lead_entity_type", "")
    with_email = sum(1 for l in leads if l.get("email"))

    parts = [
        f"# Lead Generation Report: {name}",
        "",
        f"*Generated {generated_at} · {len(leads)} leads "
        f"({with_email} with email) · Powered by Mistral AI ({MISTRAL_MODEL})*",
        "",
        "---",
        "",
        "## 1. Company Profile",
        "",
        f"- **Company:** {name} ({profile.get('company_url', '')})",
        f"- **What they do:** {profile.get('what_they_do', '')}",
        f"- **Products / services:** {', '.join(profile.get('products_services') or [])}",
        f"- **Ideal customer profile:** {profile.get('ideal_customer_profile', '')}",
        f"- **Lead target:** {target}",
        "",
        "## 2. Competitor Landscape",
        "",
        competitor_md,
        "",
        f"## 3. Leads List ({len(leads)})",
        "",
        "A CSV copy of this table is saved alongside this report. Contact "
        "details are as publicly listed on the source pages — verify before "
        "outreach, and comply with applicable anti-spam laws.",
        "",
        leads_to_markdown_table(leads),
        "",
        "## 4. Sources",
        "",
    ]
    seen_urls = set()
    n = 0
    for src in lead_sources:
        if src.url in seen_urls:
            continue
        seen_urls.add(src.url)
        n += 1
        parts.append(f"{n}. [{src.title.replace(chr(10), ' ').strip()}]({src.url})")
    if n == 0:
        parts.append("No lead source pages were successfully scraped.")

    return "\n".join(parts)


def run_lead_finding(
    client: Mistral, company_url: str, audience: str, count: int, no_pdf: bool,
    location: str = "", radius_km: int = 80,
) -> tuple[Path, Path]:
    """End-to-end lead-finding pipeline: profile the company, analyze its
    competitors, hunt for matching lead organizations across the web, and
    save a leads CSV plus a markdown/PDF report.
    Leads target small/medium businesses near `location` (defaults to the
    company's own detected location) within roughly `radius_km`.
    Returns (csv_path, markdown_report_path)."""
    count = max(10, min(count, LEADS_MAX_COUNT))

    print("\n=== Lead-Finding Mode ===")
    print(f"Company: {company_url}")
    if audience:
        print(f"Audience: {audience}")
    if location:
        print(f"Location: {location} (~{radius_km} km radius)")
    print(f"Target leads: {count}\n")

    print("[1/6] Profiling the company...")
    profile = profile_company(client, company_url, audience)
    target = audience or profile.get("lead_entity_type", "")
    lead_location = location or profile.get("company_location", "")
    print(f"  company: {profile.get('company_name')}")
    print(f"  what they do: {profile.get('what_they_do')}")
    print(f"  lead target: {target}")
    if lead_location:
        print(f"  lead area: in/around {lead_location} (~{radius_km} km)")
    else:
        print("  lead area: no location detected — searching without a geographic anchor")
    print()

    print("[2/6] Finding and analyzing competitors...")
    competitor_md, _ = find_competitors(client, profile, lead_location)
    print()

    print("[3/6] Generating lead-hunting search queries...")
    queries = generate_lead_queries(client, profile, audience, lead_location, radius_km)
    for q in queries:
        print(f"  - {q}")
    print()

    print("[4/6] Searching and scraping candidate lead pages...")
    urls = run_searches(queries, LEAD_RESULTS_PER_QUERY, LEAD_MAX_URLS)
    if not urls:
        print("No search results found for lead queries. Try a more specific --audience.")
        sys.exit(1)
    sources = scrape_all(urls)
    print(f"  {len(sources)}/{len(urls)} pages scraped\n")
    if not sources:
        print("No lead pages could be scraped. Try a different --audience or run again later.")
        sys.exit(1)

    print("[5/6] Extracting leads via Mistral...")
    # longest pages first — directories and list articles tend to be long
    sources.sort(key=lambda s: s.word_count, reverse=True)
    # no single page may fill the whole quota — forces source diversity
    per_source_cap = max(10, count // 5)
    leads_by_key: dict[str, dict] = {}
    calls = 0
    for source in sources:
        if len(leads_by_key) >= count or calls >= LEAD_MAX_EXTRACT_CALLS:
            break
        calls += 1
        extracted = extract_leads_from_source(client, profile, audience, source,
                                              lead_location, radius_km)
        new = 0
        for lead in extracted:
            key = _lead_key(lead)
            if key in leads_by_key:
                _merge_lead_fields(leads_by_key[key], lead)
            elif new < per_source_cap:
                leads_by_key[key] = lead
                new += 1
        print(f"  [{calls}] {source.url}  -> +{new} new leads (total {len(leads_by_key)})")

    leads = list(leads_by_key.values())[:LEADS_MAX_COUNT]
    if not leads:
        print("No leads could be extracted. Try a more specific --audience.")
        sys.exit(1)
    if len(leads) < count:
        print(f"  ! reached {len(leads)} leads (target was {count}) — sources exhausted")

    missing_website = sum(1 for l in leads if not l.get("website"))
    if missing_website:
        print(f"\n  looking up websites for {missing_website} leads that lack one "
              f"(budget: {LEAD_WEBSITE_LOOKUPS} searches)...")
        found_sites = find_missing_websites(leads, target)
        print(f"  found {found_sites} websites")

    missing_email = sum(1 for l in leads if not l.get("email"))
    if missing_email:
        print(f"\n  enriching contacts: {missing_email} leads lack an email, "
              f"visiting their websites (budget: {LEAD_ENRICH_MAX_FETCHES} fetches)...")
        found = enrich_leads(leads)
        print(f"  filled {found} emails from lead websites")

    # lookups may have revealed duplicates that keyed differently before
    leads = dedupe_leads(leads)[:LEADS_MAX_COUNT]

    # most actionable leads first: email > website > name-only
    leads.sort(key=lambda l: (not l.get("email"), not l.get("website"), l.get("name", "").lower()))

    print("\n[6/6] Saving leads CSV and report...")
    company_name = profile.get("company_name", "company")
    csv_path = save_leads_csv(leads, company_name)
    with_email = sum(1 for l in leads if l.get("email"))
    print(f"  saved csv: {csv_path}  ({len(leads)} leads, {with_email} with email)")

    report = build_leads_report(profile, audience, competitor_md, leads, sources)
    md_path = save_markdown(report, company_name, prefix="leads")
    print(f"  saved report: {md_path}")

    if not no_pdf and GENERATE_PDF_DEFAULT:
        pdf_path = convert_to_pdf(md_path)
        if pdf_path:
            print(f"  saved pdf: {pdf_path}")

    print("\nDone.")
    return csv_path, md_path


# ============================================================================
# COMPANY-PROFILE MODE
# ============================================================================

def _looks_like_url(text: str) -> bool:
    """True if the input is a URL rather than a company name."""
    text = text.strip()
    return text.startswith(("http://", "https://")) or (" " not in text and "." in text)


def resolve_company_website(company: str) -> tuple[str, Optional[Source]]:
    """Find and scrape the company's official website. Accepts either a URL
    (used directly) or a company name (resolved via DDG with a name-vs-domain
    sanity check). Returns (url, scraped homepage or None)."""
    if _looks_like_url(company):
        url = company if company.startswith(("http://", "https://")) else "https://" + company
        return url, scrape_url(url)

    print(f"  resolving official website for {company!r}...")
    with DDGS() as ddgs:
        try:
            try:
                results = ddgs.text(f"{company} official website",
                                    backend=SEARCH_BACKEND, max_results=6)
            except TypeError:
                results = ddgs.text(f"{company} official website", max_results=6)
        except Exception as exc:
            print(f"    ! website lookup failed: {exc}")
            results = []

    best_url = ""
    for r in results or []:
        url = r.get("href") or r.get("url") or r.get("link")
        if not url or _is_aggregator(url) or not _name_matches_domain(company, url):
            continue
        if not best_url:
            best_url = url  # best name-matching result, even if it blocks scraping
        source = scrape_url(url)
        if source:
            return url, source

    return best_url, None


def scrape_official_site(base_url: str, homepage: Optional[Source]) -> list[Source]:
    """Scrape the official site's key subpages (about/services/products/
    pricing) in parallel, so the profile captures everything they offer."""
    base = base_url.rstrip("/")
    root_dom = domain_of(base_url)
    sources: list[Source] = [homepage] if homepage else []
    seen_urls = {homepage.url if homepage else base}

    candidates = [base + p for p in PROFILE_SITE_PATHS if base + p not in seen_urls]
    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
        futures = {pool.submit(scrape_url, url): url for url in candidates}
        for future in as_completed(futures):
            try:
                src = future.result(timeout=SCRAPE_TIMEOUT_SECONDS)
            except Exception:
                src = None
            if src and domain_of(src.url) == root_dom:
                sources.append(src)
                print(f"    ok    {src.url}  ({src.word_count} words)")
    return sources


PROFILE_SYSTEM_PROMPT = """You are a corporate research assistant profiling a
company for a business audience. Be precise and data-driven. Whenever you
state a fact from the provided sources, cite it inline as [Source: URL]
using the exact URLs given — never invent a URL. For market value: report
market capitalization if the company is public, or latest valuation/funding
raised if private; if the sources contain neither, say "not publicly
disclosed in available sources" — never invent a figure. Only name
competitors supported by the sources or genuinely well-known in this space.
Do not add a top-level title; start directly with the requested sections."""


def generate_company_profile(
    client: Mistral, company: str, website: str, sources: list[Source]
) -> str:
    """Write the company profile via Mistral from the scraped material."""
    context = format_source_context(sources)
    if not context:
        context = ("(No pages could be scraped. Profile from general knowledge "
                   "only, and clearly say that specifics could not be verified.)")

    user_prompt = f"""
COMPANY TO PROFILE: {company}
OFFICIAL WEBSITE: {website or 'could not be determined'}

SOURCE MATERIAL (official site pages first, then web sources):
{context}

Write the company profile in markdown with exactly these sections:

## Company Overview
What the company actually does in plain language, where it operates, its
overall business model (how it works and makes money), and its market value
(market cap / valuation / total funding — with citations, or state that it
is not disclosed in the sources).

## Key Services & Offerings
Every distinct service and product the sources mention, as a bulleted list
or table with a one-line description of each. Include pricing/tiers if the
sources show them.

## Top Competitors
The 3-5 most direct competitors, as a table: Competitor | Website |
How they compete | Key differentiator vs {company}. Follow with 2-3
sentences on {company}'s competitive position.

Cite sources inline as [Source: URL] throughout.
""".strip()

    print("  -> generating company profile via Mistral...")
    return call_mistral(client, PROFILE_SYSTEM_PROMPT, user_prompt, max_tokens=3000)


def run_company_profile(client: Mistral, company: str, no_pdf: bool) -> Path:
    """End-to-end company-profile pipeline: resolve the official website,
    scrape it plus the web, and write a profile covering overview, business
    model, market value, services, and competitors.
    Returns the path of the saved markdown profile."""
    print("\n=== Company-Profile Mode ===")
    print(f"Company: {company}\n")

    print("[1/4] Finding and scraping the official website...")
    website, homepage = resolve_company_website(company)
    if website:
        print(f"  official website: {website}")
        site_sources = scrape_official_site(website, homepage)
        print(f"  scraped {len(site_sources)} page(s) from the official site\n")
    else:
        site_sources = []
        print("  ! could not resolve/scrape an official website — continuing "
              "with web sources only\n")

    print("[2/4] Searching the web for services, financials, and competitors...")
    queries = [t.format(company=company) for t in PROFILE_QUERY_TEMPLATES]
    urls = run_searches(queries, PROFILE_RESULTS_PER_QUERY, PROFILE_MAX_URLS)
    site_dom = domain_of(website)
    urls = [u for u in urls if domain_of(u) != site_dom]  # site already scraped
    web_sources = scrape_all(urls)
    print(f"  {len(web_sources)}/{len(urls)} web pages scraped\n")

    sources = site_sources + web_sources  # official site first = highest priority
    if not sources:
        print("  ! nothing could be scraped at all; the profile will rely on "
              "the model's general knowledge and say so explicitly.")

    print("[3/4] Generating the profile...")
    profile_md = generate_company_profile(client, company, website, sources)

    print("\n[4/4] Saving...")
    generated_at = dt.datetime.now().strftime("%Y-%m-%d %H:%M")
    report = "\n".join([
        f"# Company Profile: {company}",
        "",
        f"*Generated {generated_at} · {len(sources)} sources analyzed · "
        f"Powered by Mistral AI ({MISTRAL_MODEL})*",
        "",
        "---",
        "",
        profile_md,
        "",
        "## Sources",
        "",
    ] + [f"{i}. [{s.title.replace(chr(10), ' ').strip()}]({s.url})"
         for i, s in enumerate(sources, 1)])

    md_path = save_markdown(report, company, prefix="profile")
    print(f"  saved: {md_path}")

    if not no_pdf and GENERATE_PDF_DEFAULT:
        pdf_path = convert_to_pdf(md_path)
        if pdf_path:
            print(f"  saved pdf: {pdf_path}")

    print("\nDone.")
    return md_path


# ============================================================================
# CLI / MAIN
# ============================================================================

def parse_cli_args() -> argparse.Namespace:
    """Parse CLI arguments for both modes (research report / lead finding)."""
    parser = argparse.ArgumentParser(description="Business Intelligence Research Agent")
    parser.add_argument("topic", nargs="*", help="Business topic/hints to research (report mode)")
    parser.add_argument("--leads", metavar="COMPANY_URL", default="",
                        help="Lead-finding mode: your company's website URL")
    parser.add_argument("--profile", metavar="COMPANY", default="",
                        help="Company-profile mode: company name or website URL "
                             "to profile (overview, services, market value, competitors)")
    parser.add_argument("--audience", default="",
                        help="Lead-finding mode: who the leads should be, "
                             "e.g. 'engineering colleges in India'")
    parser.add_argument("--count", type=int, default=LEADS_TARGET_COUNT,
                        help=f"Lead-finding mode: target number of leads "
                             f"(default {LEADS_TARGET_COUNT}, max {LEADS_MAX_COUNT})")
    parser.add_argument("--no-pdf", action="store_true", help="Skip PDF export")
    return parser.parse_args()


def run_report(client: Mistral, topic: str, no_pdf: bool) -> Path:
    """End-to-end research-report pipeline (the original mode).
    Returns the path of the saved markdown report."""
    print("\n=== Business Intelligence Research Agent ===")
    print(f"Topic: {topic}\n")

    print("[1/5] Searching the web...")
    urls = search_web(topic)
    if not urls:
        print("No search results found at all. Check your internet connection or try a more specific topic.")
        sys.exit(1)
    print(f"  found {len(urls)} unique URLs\n")

    print("[2/5] Scraping sources...")
    sources = scrape_all(urls)
    print(f"  {len(sources)}/{len(urls)} URLs scraped successfully\n")

    if not sources:
        print("  ! No sources could be scraped. Continuing with the model's general knowledge only -")
        print("    the report will explicitly flag unsourced figures as estimates.")
    elif len(sources) < MIN_USABLE_SOURCES:
        print(f"  ! Only {len(sources)} usable source(s) (recommended >= {MIN_USABLE_SOURCES}). Continuing anyway.")

    print("\n[3/5] Preparing source context for the LLM...")
    source_context = format_source_context(sources)
    print(f"  context size: ~{estimate_tokens(source_context)} tokens\n")

    workers = max(1, int(os.getenv("REPORT_SECTION_WORKERS", "3")))
    print(f"[4/5] Generating {len(REPORT_SECTIONS)} report sections via Mistral AI ({workers} in parallel)...")
    section_contents: dict[str, str] = {}
    all_titles = [s["title"] for s in REPORT_SECTIONS]

    def _gen(section):
        # Give each section the OTHER section titles so it avoids overlap —
        # this replaces the old sequential "already written" dependency.
        others = [t for t in all_titles if t != section["title"]]
        return section["key"], generate_section(client, topic, section, source_context, others)

    with ThreadPoolExecutor(max_workers=workers) as pool:
        for key, content in pool.map(_gen, REPORT_SECTIONS):
            section_contents[key] = content
    print()

    print("[5/5] Assembling and saving the report...")
    report = assemble_report(topic, section_contents, sources)
    md_path = save_markdown(report, topic)
    total_words = len(report.split())
    print(f"  saved markdown: {md_path}  (~{total_words} words, ~{total_words // 600 + 1} pages)")

    if not no_pdf and GENERATE_PDF_DEFAULT:
        pdf_path = convert_to_pdf(md_path)
        if pdf_path:
            print(f"  saved pdf: {pdf_path}")

    print("\nDone.")
    return md_path


def main() -> None:
    if not (os.getenv("GEMINI_API_KEYS") or os.getenv("GEMINI_API_KEY")):
        print("ERROR: GEMINI_API_KEYS not set. Copy .env.example to .env and add your Gemini key.")
        sys.exit(1)

    args = parse_cli_args()
    client = None  # re-platformed to Gemini; LLM/embeddings need no client object

    if args.leads:
        run_lead_finding(client, args.leads, args.audience, args.count, args.no_pdf)
        return

    if args.profile:
        run_company_profile(client, args.profile, args.no_pdf)
        return

    topic = " ".join(args.topic).strip()
    if not topic:
        topic = input("Enter a business topic to research: ").strip()
    if not topic:
        print("No topic provided. Exiting.")
        sys.exit(1)
    run_report(client, topic, args.no_pdf)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nInterrupted by user.")
        sys.exit(130)
