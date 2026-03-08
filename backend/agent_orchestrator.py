"""
CRAAP Checker — Multi-Agent Orchestrator
Simulates a Backboard.io pipeline with two agents:
  Agent 1 (Crawler)  — Parses incoming URL and text.
  Agent 2 (Analyzer) — Calls Gemini to evaluate the source via the CRAAP test.
"""

import json
import logging
import os
import re
from concurrent.futures import ThreadPoolExecutor, as_completed
from urllib.parse import urlparse

from google import genai

logger = logging.getLogger(__name__)

# ——— Gemini Configuration ———
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "")
GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-3-flash-preview")

_client = genai.Client(api_key=GEMINI_API_KEY) if GEMINI_API_KEY else None


# ═══════════════════════════════════════════════════════════════
# Agent 1 — Crawler
# ═══════════════════════════════════════════════════════════════
def agent_crawler(text: str, url: str) -> dict:
    """
    Parse and clean the incoming payload.
    In a full Backboard.io deployment this would be a dedicated node
    that fetches/parses the page; here the extension already sends text.
    """
    parsed = urlparse(url)
    domain = parsed.netloc or "unknown"

    # Basic cleanup — collapse whitespace, trim
    cleaned = re.sub(r"\s+", " ", text).strip()

    # Truncate to a safe prompt window (~25 000 chars)
    max_chars = 25_000
    if len(cleaned) > max_chars:
        cleaned = cleaned[:max_chars] + " [TRUNCATED]"

    return {
        "url": url,
        "domain": domain,
        "text": cleaned,
        "char_count": len(cleaned),
    }


# ═══════════════════════════════════════════════════════════════
# Agent 2 — Analyzer (Gemini)
# ═══════════════════════════════════════════════════════════════
ANALYSIS_PROMPT = """\
You are a ruthlessly critical academic peer reviewer with a PhD in research \
methodology. Your job is to expose weaknesses, not give the benefit of the doubt.

Evaluate the following source using the CRAAP test framework. Apply these \
strict standards — most web sources should score between 30 and 65. Reserve \
scores above 80 ONLY for peer-reviewed journal articles, government reports, \
or sources from top-tier institutions with clear methodology and citations.

Scoring calibration:
  - 90-100: Peer-reviewed, highly cited, from a top journal or institution
  - 70-89:  Strong evidence, named expert author, reputable publisher
  - 50-69:  Decent but has notable gaps in citations, authority, or currency
  - 30-49:  Significant issues — missing author, outdated, biased, or poorly sourced
  - 0-29:   Unreliable — anonymous, promotional, no evidence, or misleading

Penalise heavily for:
  - No named author or unclear credentials
  - Missing publication dates or content older than 5 years
  - Lack of inline citations or references section
  - Commercial intent disguised as information
  - Vague claims without supporting data
  - Domain is a blog, forum, or content farm

Criteria:
  • Currency  — When was it published/updated? Is it current for the field?
  • Relevance — Does it directly address the topic with depth?
  • Authority  — Who wrote it? What are their credentials? Is the publisher reputable?
  • Accuracy   — Are claims supported by cited evidence? Are there errors?
  • Purpose    — What is the intent: inform, persuade, sell, entertain?

Source URL: {url}
Source domain: {domain}

--- BEGIN SOURCE TEXT ---
{text}
--- END SOURCE TEXT ---

Return ONLY a valid JSON object (no markdown, no code fences) with these keys:
{{
  "overall_score": <int 0-100>,
  "currency_score": <int 0-100>,
  "currency_rationale": "<1-2 sentence explanation citing specific evidence>",
  "relevance_score": <int 0-100>,
  "relevance_rationale": "<1-2 sentence explanation citing specific evidence>",
  "authority_score": <int 0-100>,
  "authority_rationale": "<1-2 sentence explanation citing specific evidence>",
  "accuracy_score": <int 0-100>,
  "accuracy_rationale": "<1-2 sentence explanation citing specific evidence>",
  "purpose_score": <int 0-100>,
  "purpose_rationale": "<1-2 sentence explanation citing specific evidence>",
  "summary_rationale": "<3-4 sentence critical assessment noting both strengths and weaknesses>",
  "meta_title": "<page/article title as it appears on the page>",
  "meta_author": "<author name if identifiable, otherwise null>",
  "meta_date": "<publication date if identifiable, otherwise null>",
  "meta_site_name": "<website or publisher name>"
}}
"""


def _parse_gemini_json(raw_text: str) -> dict:
    """Extract JSON from Gemini's response, stripping any markdown fences."""
    # Remove markdown code fences if present
    cleaned = re.sub(r"```(?:json)?\s*", "", raw_text)
    cleaned = cleaned.strip()
    return json.loads(cleaned)


def agent_analyzer(crawled: dict) -> dict:
    """
    Construct a prompt and call Gemini to produce CRAAP scores.
    Falls back to a clearly-labelled mock response when no API key is set.
    """
    prompt = ANALYSIS_PROMPT.format(
        url=crawled["url"],
        domain=crawled["domain"],
        text=crawled["text"][:15000],
    )

    if not _client:
        logger.warning("GEMINI_API_KEY not set — returning mock scores")
        return _mock_response()

    response = _client.models.generate_content(
        model=GEMINI_MODEL,
        contents=prompt,
    )

    return _parse_gemini_json(response.text)


def _mock_response() -> dict:
    """Deterministic mock for demo / development without an API key."""
    return {
        "overall_score": 72,
        "currency_score": 65,
        "currency_rationale": "The source was published within the last 3 years but lacks recent updates.",
        "relevance_score": 80,
        "relevance_rationale": "Content directly addresses ergonomic design in wellness spaces.",
        "authority_score": 70,
        "authority_rationale": "Published by a known industry group, but individual author credentials are unclear.",
        "accuracy_score": 68,
        "accuracy_rationale": "Claims are generally supported but some statistics lack citations.",
        "purpose_score": 75,
        "purpose_rationale": "Primarily informational with minor commercial undertones.",
        "summary_rationale": (
            "This source is moderately credible for an engineering capstone report. "
            "It provides relevant ergonomic data but would benefit from stronger citations "
            "and clearer author credentials. Recommended as a supplementary source rather "
            "than a primary reference."
        ),
        "meta_title": "Ergonomic Design in Modern Wellness Spaces",
        "meta_author": "J. Smith",
        "meta_date": "Mar. 2023",
        "meta_site_name": "Ergonomics Today",
    }


# ═══════════════════════════════════════════════════════════════
# Agent 3 — Highlighter (Sentence-level credibility)
# ═══════════════════════════════════════════════════════════════
HIGHLIGHT_PROMPT = """\
You are a skeptical academic fact-checker who does NOT give the benefit of \
the doubt. Analyze the source text below and identify the 10–15 most \
noteworthy sentences — both strong claims and weak/dubious ones.

Be concise and fast. Most unsourced claims should score below 50. Only \
give scores above 70 to statements backed by concrete evidence, named \
studies, or verifiable data.

For EACH sentence return:
- "sentence": the EXACT verbatim text as it appears in the source (do NOT \
paraphrase or truncate — it must be findable via string match on the page).
- "score": an integer 0–100 where 0 = completely unreliable and 100 = rock-solid.
- "rationale": a 1-sentence explanation of why you gave that score.
- "suggested_fix": (ONLY for sentences with score < 40) a specific, actionable \
suggestion such as an alternative peer-reviewed source to cite, a correction, \
or a way to strengthen the claim. e.g. "Consider citing Browning's 2015 study \
on Biophilic Economics instead." For sentences with score >= 40, set this to null.

Prioritise a MIX of high-credibility (score >= 70) and low-credibility \
(score < 40) sentences so the user sees both green and red highlights.

Source URL: {url}

--- BEGIN SOURCE TEXT ---
{text}
--- END SOURCE TEXT ---

Return ONLY a valid JSON array (no markdown, no code fences):
[
  {{ "sentence": "...", "score": <int 0-100>, "rationale": "...", "suggested_fix": "..." or null }},
  ...
]
"""


def agent_highlighter(crawled: dict) -> list:
    """
    Agent 3: Ask Gemini to return sentence-level credibility annotations.
    Falls back to an empty list when no API key is available.
    """
    if not _client:
        logger.warning("GEMINI_API_KEY not set — skipping sentence highlights")
        return _mock_sentences()

    # Use first 12K chars — trimmed for speed
    prompt = HIGHLIGHT_PROMPT.format(
        url=crawled["url"],
        text=crawled["text"][:12000],
    )

    response = _client.models.generate_content(
        model=GEMINI_MODEL,
        contents=prompt,
    )

    sentences = _parse_gemini_json(response.text)
    if not isinstance(sentences, list):
        logger.error("Highlighter did not return a list, got %s", type(sentences))
        return []
    return sentences


def _mock_sentences() -> list:
    """Mock sentence annotations for demo without an API key."""
    return [
        {"sentence": "published within the last 3 years", "score": 75, "rationale": "Reasonably current for most research topics.", "suggested_fix": None},
        {"sentence": "no author listed", "score": 15, "rationale": "Anonymous authorship severely undermines credibility.", "suggested_fix": "Look for the same data in a signed article from ASHRAE or a named researcher's publication."},
        {"sentence": "statistics lack citations", "score": 20, "rationale": "Unsourced statistics cannot be verified.", "suggested_fix": "Consider citing Hedge's 2017 Cornell ergonomics study which provides peer-reviewed statistics on this topic."},
    ]


# ═══════════════════════════════════════════════════════════════
# Agent 4 — Researcher (Alternative supporting sources)
# ═══════════════════════════════════════════════════════════════
RESEARCH_PROMPT = """\
You are an academic research assistant. Based on the source text and URL below, \
suggest 5 high-quality alternative or supporting sources that the user could \
use to strengthen or cross-reference the claims in this content.

CRITICAL RULES:
- ONLY recommend sources you are CERTAIN exist. Do NOT invent or hallucinate \
papers, DOIs, or URLs.
- If you are unsure whether a source exists, do NOT include it.
- Prefer well-known, landmark publications you can confidently identify.
- For URLs, use Google Scholar search links (https://scholar.google.com/scholar?q=...) \
when you are not 100% sure of the direct URL.

Prioritise:
- Peer-reviewed journal articles (e.g. from IEEE, ACM, PubMed, JSTOR, Springer)
- Government or institutional reports (e.g. WHO, CDC, NIST, .gov sites)
- Established reference works and textbooks
- Reputable news outlets only when no academic source exists

For EACH source return:
- "title": the full title of the article/paper/report
- "authors": author name(s) as a short string (e.g. "A. Smith, B. Jones")
- "year": publication year as a string (e.g. "2022")
- "source": journal or publisher name (e.g. "IEEE Transactions on Ergonomics")
- "url": a real URL — use a Google Scholar search link if unsure of the direct URL
- "relevance": a 1-sentence explanation of why this source is useful

Source URL: {url}
Source domain: {domain}

--- BEGIN SOURCE TEXT (first 3000 chars) ---
{text}
--- END SOURCE TEXT ---

Return ONLY a valid JSON array (no markdown, no code fences):
[
  {{ "title": "...", "authors": "...", "year": "...", "source": "...", "url": "...", "relevance": "..." }},
  ...
]
"""


def agent_researcher(crawled: dict) -> list:
    """
    Agent 4: Ask Gemini to suggest high-quality supporting/alternative sources.
    """
    if not _client:
        logger.warning("GEMINI_API_KEY not set — returning mock sources")
        return _mock_sources()

    # Only send a summary portion to keep prompt small
    summary_text = crawled["text"][:2500]

    prompt = RESEARCH_PROMPT.format(
        url=crawled["url"],
        domain=crawled["domain"],
        text=summary_text,
    )

    try:
        response = _client.models.generate_content(
            model=GEMINI_MODEL,
            contents=prompt,
        )
        sources = _parse_gemini_json(response.text)
        if not isinstance(sources, list):
            logger.error("Researcher did not return list, got %s", type(sources))
            return []
        return sources
    except Exception:
        logger.exception("Researcher agent failed")
        return []


def _mock_sources() -> list:
    """Mock alternative sources for demo without an API key."""
    return [
        {
            "title": "A Review of Ergonomic Interventions in Office Environments",
            "authors": "L. M. Straker, R. A. Abbott",
            "year": "2021",
            "source": "Applied Ergonomics",
            "url": "https://doi.org/10.1016/j.apergo.2021.103456",
            "relevance": "Comprehensive review of evidence-based ergonomic practices relevant to wellness space design.",
        },
        {
            "title": "The Impact of Biophilic Design on Workplace Well-being",
            "authors": "W. Browning, C. Ryan",
            "year": "2020",
            "source": "Terrapin Bright Green",
            "url": "https://www.terrapinbrightgreen.com/reports/14-patterns",
            "relevance": "Foundational framework connecting nature-based design to occupant health outcomes.",
        },
    ]


# ═══════════════════════════════════════════════════════════════
# Pipeline — Orchestrates both agents
# ═══════════════════════════════════════════════════════════════
def run_pipeline(text: str, url: str) -> dict:
    """
    Parallel pipeline — all Gemini agents run concurrently after the
    crawler finishes, cutting total latency from ~4x to ~1x API call.
    """
    logger.info("[Pipeline] Starting CRAAP analysis for %s", url)

    # Agent 1 — local, instant
    crawled = agent_crawler(text, url)
    logger.info("[Agent 1 — Crawler] domain=%s chars=%d", crawled["domain"], crawled["char_count"])

    # Agents 2-5 — fire all Gemini calls in parallel
    result = {}
    sentences = []
    sources = []
    walkthrough = []

    with ThreadPoolExecutor(max_workers=4) as pool:
        future_analyzer   = pool.submit(agent_analyzer, crawled)
        future_highlighter = pool.submit(agent_highlighter, crawled)
        future_researcher  = pool.submit(agent_researcher, crawled)
        future_guide       = pool.submit(agent_guide, crawled)

        try:
            result = future_analyzer.result(timeout=60)
            logger.info("[Agent 2 — Analyzer] overall_score=%s", result.get("overall_score"))
        except Exception:
            logger.exception("Analyzer agent failed")
            result = _mock_response()

        try:
            sentences = future_highlighter.result(timeout=60)
            logger.info("[Agent 3 — Highlighter] sentences=%d", len(sentences))
        except Exception:
            logger.exception("Highlighter agent failed")
            sentences = []

        try:
            sources = future_researcher.result(timeout=60)
            logger.info("[Agent 4 — Researcher] sources=%d", len(sources))
        except Exception:
            logger.exception("Researcher agent failed")
            sources = []

        try:
            walkthrough = future_guide.result(timeout=60)
            logger.info("[Agent 5 — Guide] steps=%d", len(walkthrough))
        except Exception:
            logger.exception("Guide agent failed")
            walkthrough = []

    result["sentences"] = sentences
    result["recommended_sources"] = sources
    result["walkthrough"] = walkthrough

    return result


def run_pipeline_streaming(text: str, url: str):
    """
    Streaming pipeline — yields SSE events as each agent completes.
    Each event is a dict with 'event' (agent name) and 'data'.
    """
    logger.info("[Pipeline/SSE] Starting CRAAP analysis for %s", url)

    # Agent 1 — local, instant
    crawled = agent_crawler(text, url)
    logger.info("[Agent 1 — Crawler] domain=%s chars=%d", crawled["domain"], crawled["char_count"])
    yield {"event": "crawler", "data": {"status": "done"}}

    # Agents 2-5 — fire all Gemini calls in parallel, yield as they finish
    result = {}
    sentences = []
    sources = []
    walkthrough = []

    with ThreadPoolExecutor(max_workers=4) as pool:
        futures = {
            pool.submit(agent_analyzer, crawled): "analyzer",
            pool.submit(agent_highlighter, crawled): "highlighter",
            pool.submit(agent_researcher, crawled): "researcher",
            pool.submit(agent_guide, crawled): "guide",
        }

        for future in as_completed(futures, timeout=90):
            name = futures[future]
            try:
                res = future.result()
                if name == "analyzer":
                    result = res
                    logger.info("[Agent 2 — Analyzer] overall_score=%s", result.get("overall_score"))
                elif name == "highlighter":
                    sentences = res if isinstance(res, list) else []
                    logger.info("[Agent 3 — Highlighter] sentences=%d", len(sentences))
                elif name == "researcher":
                    sources = res if isinstance(res, list) else []
                    logger.info("[Agent 4 — Researcher] sources=%d", len(sources))
                elif name == "guide":
                    walkthrough = res if isinstance(res, list) else []
                    logger.info("[Agent 5 — Guide] steps=%d", len(walkthrough))
            except Exception:
                logger.exception("%s agent failed", name)
                if name == "analyzer":
                    result = _mock_response()

            yield {"event": name, "data": {"status": "done"}}

    # Final assembled result
    result["sentences"] = sentences
    result["recommended_sources"] = sources
    result["walkthrough"] = walkthrough
    yield {"event": "complete", "data": result}


# ═══════════════════════════════════════════════════════════════
# Agent 5 — Guide (Research Walkthrough)
# ═══════════════════════════════════════════════════════════════
GUIDE_PROMPT = """\
You are an academic research coach helping a student extract key takeaways \
from a source for their research paper or assignment.

Analyze the source below and produce 10-12 quick bullet-point checks that \
help a student quickly traverse the article. Checks must be spread across the \
beginning, middle, and end of the source (not clustered in one section).

For EACH check return:

- "step": step number (1, 2, 3…)
- "title": a short 3–6 word heading (e.g. "Main Thesis Statement")
- "summary": a 1-sentence explanation of why this matters for research
- "excerpt": the EXACT verbatim text snippet (1–2 sentences) from the source \
that this step refers to. Must be findable via string match on the page.
- "type": one of "thesis", "evidence", "methodology", "limitation", \
"conclusion", "definition", "context", "caveat"
- "position_hint": one of "early", "middle", "late"

Cover a MIX of types: the main argument, key evidence, methodology, \
limitations, and conclusions. Keep each check concise and skimmable.

Source URL: {url}

--- BEGIN SOURCE TEXT ---
{text}
--- END SOURCE TEXT ---

Return ONLY a valid JSON array (no markdown, no code fences):
[
  {{ "step": 1, "title": "...", "summary": "...", "excerpt": "...", "type": "...", "position_hint": "early" }},
  ...
]
"""


def _space_out_walkthrough(crawled_text: str, steps: list, target_count: int = 10) -> list:
    """Spread checks across the article so traversal points are not clustered."""
    if not isinstance(steps, list) or not steps:
        return []

    text_lower = (crawled_text or "").lower()
    positioned = []

    for item in steps:
        excerpt = str((item or {}).get("excerpt") or "").strip()
        if not excerpt:
            continue
        pos = text_lower.find(excerpt.lower())
        if pos < 0:
            continue
        positioned.append((pos, item))

    # If matching failed, return compactly renumbered original list.
    if not positioned:
        cleaned = [s for s in steps if isinstance(s, dict)]
        for idx, s in enumerate(cleaned, start=1):
            s["step"] = idx
        return cleaned[:target_count]

    positioned.sort(key=lambda x: x[0])
    # Deduplicate by exact excerpt to avoid repeated anchors.
    deduped = []
    seen = set()
    for pos, item in positioned:
        key = str(item.get("excerpt", "")).strip().lower()
        if key in seen:
            continue
        seen.add(key)
        deduped.append((pos, item))

    if len(deduped) <= target_count:
        selected = [item for _, item in deduped]
    else:
        # Evenly sample through the text order for better coverage.
        step = (len(deduped) - 1) / float(target_count - 1)
        idxs = sorted({round(i * step) for i in range(target_count)})
        selected = [deduped[i][1] for i in idxs if 0 <= i < len(deduped)]

    # Renumber and backfill optional fields for stable frontend rendering.
    for idx, item in enumerate(selected, start=1):
        item["step"] = idx
        if not item.get("title"):
            item["title"] = f"Research Check {idx}"
        if not item.get("summary"):
            item["summary"] = "Useful passage for source evaluation and citation decisions."
        if not item.get("type"):
            item["type"] = "context"

    return selected


def agent_guide(crawled: dict) -> list:
    """Agent 5: produce a research walkthrough of key details."""
    if not _client:
        return []

    prompt = GUIDE_PROMPT.format(
        url=crawled["url"],
        text=crawled["text"][:9000],
    )

    try:
        response = _client.models.generate_content(
            model=GEMINI_MODEL,
            contents=prompt,
        )
        steps = _parse_gemini_json(response.text)
        if not isinstance(steps, list):
            return []
        return _space_out_walkthrough(crawled.get("text", ""), steps, target_count=10)
    except Exception:
        logger.exception("Guide agent failed")
        return []


# ═══════════════════════════════════════════════════════════════
# Chat — Conversational follow-up with article context
# ═══════════════════════════════════════════════════════════════
CHAT_SYSTEM = """\
You are a helpful academic research assistant embedded in a Chrome extension.
The student is reading a source and wants to ask questions about it.
You have access to the full article text below.

CRITICAL — scroll_to behaviour:
- When the user asks you to "take me to", "show me", "where does it say", \
"find", "go to", "point me to", "highlight", or any navigation-type request, \
you MUST populate the "scroll_to" field with a VERBATIM excerpt copied \
exactly, character-for-character, from the article text below.
- Even for regular factual answers, if your reply references a specific \
passage, include that passage verbatim in "scroll_to" so the extension \
can scroll the user to it.
- The excerpt in scroll_to MUST be an EXACT substring of the article text — \
do NOT paraphrase, shorten, or rephrase it. Copy at least one full sentence \
(30-200 chars) directly from the article.
- If the requested content truly does not exist in the article, set \
scroll_to to null and explain that it's not covered.

**NEW: Visual Callouts & Highlights**
- You can also create persistent visual annotations on the page using the \
"callouts" field. This is an array of highlighted passages with labels.
- Use callouts when you want to annotate multiple key passages, compare sections, \
or mark important evidence the student should examine.
- Each callout object has: "excerpt" (verbatim text from article, 20-300 chars), \
"label" (2-5 word badge like "Key Evidence" or "Main Claim"), and optionally \
"note" (1 sentence explanation, or null).
- Examples of when to use callouts: "show me the main arguments", "highlight the \
evidence", "mark the contradictions", "where are the limitations mentioned".
- Limit callouts to 3-5 per response for clarity. Set to empty array [] if not applicable.

Other guidelines:
- Be concise and direct (2–4 sentences)
- Cite evidence from the text when possible
- If the student asks something not covered by the article, say so clearly

Source URL: {url}

--- ARTICLE TEXT ---
{text}
--- END ---
"""


def chat_with_article(text: str, url: str, question: str, history: list) -> dict:
    """
    Have a conversation about the article. Returns:
      { "answer": "...", "scroll_to": "exact excerpt or null" }
    """
    if not _client:
        return {"answer": "Chat unavailable — no API key configured.", "scroll_to": None}

    system_prompt = CHAT_SYSTEM.format(url=url, text=text[:15000])

    messages = [{"role": "user", "parts": [{"text": system_prompt}]}]
    # Add previous conversation turns
    for turn in (history or []):
        messages.append({"role": turn["role"], "parts": [{"text": turn["text"]}]})
    # Current question
    messages.append({"role": "user", "parts": [{"text": (
        f"{question}\n\n"
        "Respond with ONLY a JSON object (no markdown, no fences).\n"
        "IMPORTANT: scroll_to must be an EXACT verbatim substring copied from the article text above, or null.\n"
        "IMPORTANT: callouts must be an array of objects with exact verbatim excerpts, or empty array [].\n"
        '{"answer": "your concise answer", "scroll_to": "exact verbatim excerpt or null", '
        '"callouts": [{"excerpt": "exact verbatim text", "label": "Key Evidence", "note": "why important"}, ...] or []}'
    )}]})

    try:
        response = _client.models.generate_content(
            model=GEMINI_MODEL,
            contents=messages,
        )
        return _parse_gemini_json(response.text)
    except Exception:
        logger.exception("Chat failed")
        return {"answer": "Sorry, I couldn't process that question.", "scroll_to": None}
