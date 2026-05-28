#!/usr/bin/env python3
"""
ai_evaluator.py — Evaluate trending content for ad potential using AI.
Supports: Google Gemini API (default) or OpenAI API.
Scores: viral_score, ad_score, generates ad_angles + hooks.
Outputs scored JSON ready for image generation.
"""

import json
import os
import sys
import time
import logging
from pathlib import Path
from datetime import datetime

PROJECT_DIR = Path(__file__).parent.parent

# Load .env file
try:
    from dotenv import load_dotenv
    load_dotenv(PROJECT_DIR / ".env")
except ImportError:
    pass

OUTPUT_DIR = PROJECT_DIR / "output"
LOG_DIR = PROJECT_DIR / "logs"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.FileHandler(LOG_DIR / "ai_evaluator.log"),
        logging.StreamHandler()
    ]
)
logger = logging.getLogger(__name__)

# --- PROVIDER CONFIG ---
# Set PROVIDER=google (default) or PROVIDER=openai
PROVIDER = os.environ.get("PROVIDER", "google").lower()

# Google Gemini
GOOGLE_API_KEY = os.environ.get("GOOGLE_API_KEY", "")
GOOGLE_MODEL = os.environ.get("GOOGLE_MODEL", "gemini-2.0-flash")

# OpenAI (fallback)
OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY", "")
OPENAI_BASE_URL = os.environ.get("OPENAI_BASE_URL", "https://api.openai.com/v1")
OPENAI_MODEL = os.environ.get("OPENAI_MODEL", "gpt-4o-mini")

# Target niches for ad conversion
DEFAULT_NICHES = [
    "AI/chatbot/automation",
    "coding/startup/tech",
    "career/job/freelance",
    "education/learning",
    "small business/marketing"
]

PROMPT_SYSTEM = """You are a marketing expert who evaluates memes and trending topics for their potential as advertisements.
For each item, you must:
1. Rate viral potential (1-10) based on humor, relatability, and shareability
2. Rate ad conversion potential (1-10): Can this be turned into an attention-grabbing ad?
3. Identify the best product/service niche it could promote (e.g., "coding course", "AI tool", "job platform")
4. Suggest a hook/caption (Hindi + English) that converts the meme into an ad
5. Decide if it's brand_safe or contains sensitive content

Be selective — only score 7+ items as worth converting to ads."""

PROMPT_USER = """Niche: {niche}

Trending content to evaluate:
{trends}

Respond with a JSON array. Each item should have:
- index: the item number
- viral_score: 1-10
- ad_score: 1-10
- niche_fit: string (what product/service this could promote)
- hook_hi: string (Hindi hook/caption for the ad)
- hook_en: string (English hook/caption for the ad)
- brand_safe: boolean
- reason: string (1 sentence why this is/isn't good for ads)

Only return JSON, no other text."""


def load_trends(input_file):
    """Load trends JSON from fetcher output."""
    with open(input_file) as f:
        data = json.load(f)
    return data.get("items", [])


def call_google_gemini(prompt_text):
    """Send prompt to Google Gemini API."""
    import requests

    if not GOOGLE_API_KEY:
        logger.error("GOOGLE_API_KEY not set")
        return None

    url = f"https://generativelanguage.googleapis.com/v1beta/models/{GOOGLE_MODEL}:generateContent?key={GOOGLE_API_KEY}"

    payload = {
        "contents": [{"parts": [{"text": prompt_text}]}],
        "generationConfig": {
            "responseMimeType": "application/json",
            "maxOutputTokens": 4096,
            "temperature": 0.7
        }
    }

    try:
        for attempt in range(3):
            resp = requests.post(url, json=payload, timeout=60)
            if resp.status_code == 429:
                wait = (attempt + 1) * 15
                logger.warning(f"Rate limited, waiting {wait}s...")
                time.sleep(wait)
                continue
            resp.raise_for_status()
            result = resp.json()

            candidates = result.get("candidates", [])
            if not candidates:
                logger.error("No candidates in Gemini response")
                return None

            content = candidates[0].get("content", {})
            parts = content.get("parts", [])
            if not parts:
                logger.error("No parts in Gemini response")
                return None

            text = parts[0].get("text", "")
            return json.loads(text) if text else None

    except requests.exceptions.HTTPError as e:
        logger.error(f"Gemini API error: {e} - {e.response.text[:300] if e.response else ''}")
        return None
    except Exception as e:
        logger.error(f"Gemini call error: {e}")
        return None


def call_openai(prompt_system, prompt_user):
    """Send prompt to OpenAI API."""
    import requests

    if not OPENAI_API_KEY:
        logger.error("OPENAI_API_KEY not set")
        return None

    messages = [
        {"role": "system", "content": prompt_system},
        {"role": "user", "content": prompt_user}
    ]

    headers = {
        "Authorization": f"Bearer {OPENAI_API_KEY}",
        "Content-Type": "application/json"
    }

    payload = {
        "model": OPENAI_MODEL,
        "messages": messages,
        "response_format": {"type": "json_object"},
        "max_tokens": 4000
    }

    try:
        resp = requests.post(
            f"{OPENAI_BASE_URL}/chat/completions",
            headers=headers,
            json=payload,
            timeout=60
        )
        resp.raise_for_status()
        result = resp.json()
        content = result["choices"][0]["message"]["content"]
        return json.loads(content) if content else None

    except requests.exceptions.HTTPError as e:
        logger.error(f"OpenAI API error: {e} - {e.response.text if e.response else ''}")
        return None
    except Exception as e:
        logger.error(f"OpenAI call error: {e}")
        return None


def call_ai_evaluate(trend_items, niches):
    """Route to configured AI provider."""
    # Format trend items for prompt
    trend_lines = []
    for i, item in enumerate(trend_items[:30]):
        title = item.get("title", item.get("keyword", "N/A"))
        score = item.get("score", "N/A")
        source = item.get("source", "unknown")
        trend_lines.append(f"{i+1}. [{source}] \"{title}\" (engagement: {score})")

    trends_text = "\n".join(trend_lines)
    niche_text = ", ".join(niches)

    if PROVIDER == "google":
        logger.info(f"Using Google Gemini ({GOOGLE_MODEL}) for evaluation")
        # Gemini uses single prompt (no system/user split)
        full_prompt = f"{PROMPT_SYSTEM}\n\n{PROMPT_USER.format(niche=niche_text, trends=trends_text)}"
        result = call_google_gemini(full_prompt)

        if result is None:
            return []

        # Handle both array and object-wrapped responses
        if isinstance(result, list):
            return result
        if isinstance(result, dict):
            for key in ["evaluations", "results", "items", "data"]:
                if key in result:
                    return result[key]
            return list(result.values())[0] if result else []
        return []

    else:
        logger.info(f"Using OpenAI ({OPENAI_MODEL}) for evaluation")
        result = call_openai(PROMPT_SYSTEM, PROMPT_USER.format(niche=niche_text, trends=trends_text))

        if result is None:
            return []

        if isinstance(result, list):
            return result
        if isinstance(result, dict):
            for key in ["evaluations", "results", "items", "data"]:
                if key in result:
                    return result[key]
            return list(result.values())[0] if result else []
        return []


def score_and_filter(trend_items, min_ad_score=7):
    """Score items and filter to only high-potential ones."""
    if not trend_items:
        logger.warning("No trend items to evaluate")
        return []

    evaluations = call_ai_evaluate(trend_items, DEFAULT_NICHES)

    if not evaluations:
        logger.warning("No evaluations returned from AI")
        return []

    scored_items = []
    for ev in evaluations:
        try:
            idx = ev.get("index", 0) - 1
            if idx < 0 or idx >= len(trend_items):
                continue

            original = trend_items[idx]
            ad_score = ev.get("ad_score", 0)

            if ad_score >= min_ad_score:
                scored_items.append({
                    **original,
                    "viral_score": ev.get("viral_score", 0),
                    "ad_score": ad_score,
                    "niche_fit": ev.get("niche_fit", "general"),
                    "hook_hi": ev.get("hook_hi", ""),
                    "hook_en": ev.get("hook_en", ""),
                    "brand_safe": ev.get("brand_safe", True),
                    "eval_reason": ev.get("reason", ""),
                    "evaluated_at": datetime.utcnow().isoformat()
                })
        except Exception as e:
            logger.error(f"Error processing evaluation: {e}")
            continue

    scored_items.sort(key=lambda x: x["ad_score"], reverse=True)
    return scored_items


def main():
    run_id = datetime.utcnow().strftime("%Y%m%d_%H%M%S")
    logger.info(f"AI Provider: {PROVIDER}")

    # Find latest trends file
    trend_files = sorted(OUTPUT_DIR.glob("trends_*.json"), reverse=True)
    if not trend_files:
        logger.error("No trends file found. Run trend_fetcher.py first.")
        sys.exit(1)

    input_file = trend_files[0]
    logger.info(f"Evaluating trends from: {input_file}")

    trend_items = load_trends(input_file)
    logger.info(f"Loaded {len(trend_items)} trend items")

    scored = score_and_filter(trend_items)

    # Save evaluated output
    output_file = OUTPUT_DIR / f"evaluated_{run_id}.json"
    output_data = {
        "run_id": run_id,
        "provider": PROVIDER,
        "source_file": str(input_file),
        "evaluated_at": datetime.utcnow().isoformat(),
        "total_evaluated": len(trend_items),
        "total_scored": len(scored),
        "items": scored
    }

    with open(output_file, "w") as f:
        json.dump(output_data, f, indent=2, ensure_ascii=False)

    logger.info(f"Evaluated {len(scored)} high-potential items. Saved: {output_file}")
    print(str(output_file))
    return output_file


if __name__ == "__main__":
    main()
