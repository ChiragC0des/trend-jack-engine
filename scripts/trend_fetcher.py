#!/usr/bin/env python3
"""
trend_fetcher.py — Fetch trending content from Reddit, Google Trends, and Twitter/X
Outputs a JSON file of trending topics/memes with metadata.
"""

import json
import time
import os
import sys
import logging
from datetime import datetime, timedelta
from pathlib import Path

# --- CONFIG ---
PROJECT_DIR = Path(__file__).parent.parent
OUTPUT_DIR = PROJECT_DIR / "output"
LOG_DIR = PROJECT_DIR / "logs"
OUTPUT_DIR.mkdir(exist_ok=True)
LOG_DIR.mkdir(exist_ok=True)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.FileHandler(LOG_DIR / "trend_fetcher.log"),
        logging.StreamHandler()
    ]
)
logger = logging.getLogger(__name__)

TELEGRAM_TOKEN = os.environ.get("TELEGRAM_TOKEN", "")
TELEGRAM_CHAT_ID = os.environ.get("TELEGRAM_CHAT_ID", "")
OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY", "")
OPENAI_BASE_URL = os.environ.get("OPENAI_BASE_URL", "https://api.openai.com/v1")

# Reddit credentials (set via env or config)
REDDIT_CLIENT_ID = os.environ.get("REDDIT_CLIENT_ID", "")
REDDIT_CLIENT_SECRET = os.environ.get("REDDIT_CLIENT_SECRET", "")
REDDIT_USER_AGENT = os.environ.get("REDDIT_USER_AGENT", "TrendJackEngine/1.0")

# Subreddits to scrape for memes
MEME_SUBREDDITS = [
    "memes", "dankmemes", "wholesomememes",
    "IndianMemes", "bakchodi", "iamverysmart",
    "ProgrammerHumoor", "technicallythetruth",
    "AdviceAnimals", "me_irl"
]

# Trending niches/topics to track
TRACK_KEYWORDS = [
    "AI", "chatbot", "automation", "coding", "startup",
    "crypto", "stocks", "cricket", "bollywood", "ipl",
    "exam", "job", "interview", "remote work", "freelance"
]


def fetch_reddit_trending(limit_per_sub=10):
    """Fetch hot posts from meme subreddits using PRAW."""
    if not REDDIT_CLIENT_ID or not REDDIT_CLIENT_SECRET:
        logger.warning("Reddit credentials not set. Skipping Reddit fetch.")
        return []

    try:
        import praw
        reddit = praw.Reddit(
            client_id=REDDIT_CLIENT_ID,
            client_secret=REDDIT_CLIENT_SECRET,
            user_agent=REDDIT_USER_AGENT
        )

        posts = []
        seen_urls = set()

        for sub_name in MEME_SUBREDDITS:
            try:
                subreddit = reddit.subreddit(sub_name)
                for post in subreddit.hot(limit=limit_per_sub):
                    if post.url in seen_urls:
                        continue
                    seen_urls.add(post.url)

                    # Only image posts
                    if not post.url.endswith(('.jpg', '.jpeg', '.png', '.gif', '.webp')):
                        continue

                    posts.append({
                        "source": "reddit",
                        "subreddit": sub_name,
                        "title": post.title,
                        "url": post.url,
                        "permalink": f"https://reddit.com{post.permalink}",
                        "score": post.score,
                        "num_comments": post.num_comments,
                        "created_utc": post.created_utc,
                        "is_video": post.is_video,
                        "fetched_at": datetime.utcnow().isoformat()
                    })

                time.sleep(0.5)  # Rate limit

            except Exception as e:
                logger.error(f"Error fetching r/{sub_name}: {e}")
                continue

        logger.info(f"Fetched {len(posts)} image posts from Reddit")
        return posts

    except ImportError:
        logger.error("praw not installed. Run: pip install praw")
        return []
    except Exception as e:
        logger.error(f"Reddit fetch error: {e}")
        return []


def fetch_google_trends(geo="IN", count=20):
    """Fetch Google Trends trending searches for India."""
    try:
        from pytrends.request import TrendReq

        pytrends = TrendReq(hl='en-IN', tz=330)
        trending = pytrends.trending_related_queries(pn='india')

        results = []
        for keyword in trending[:count]:
            results.append({
                "source": "google_trends",
                "keyword": keyword,
                "geo": geo,
                "type": "search_query",
                "fetched_at": datetime.utcnow().isoformat()
            })

        # Also get real-time trending
        try:
            realtime = pytrends.realtime_trending_searches(pn='india')
            if realtime is not None:
                for _, row in realtime.head(count).iterrows():
                    results.append({
                        "source": "google_trends_realtime",
                        "keyword": row.get("title", str(row.iloc[0])),
                        "geo": geo,
                        "type": "realtime_trending",
                        "fetched_at": datetime.utcnow().isoformat()
                    })
        except Exception as e:
            logger.warning(f"Realtime trends error: {e}")

        logger.info(f"Fetched {len(results)} trending topics from Google Trends")
        return results

    except ImportError:
        logger.error("pytrends not installed")
        return []
    except Exception as e:
        logger.error(f"Google Trends error: {e}")
        return []


def fetch_x_trending(country="India"):
    """Fetch X/Twitter trending topics via web scraping (no API key needed)."""
    try:
        import requests
        from bs4 import BeautifulSoup

        # Use trends24.in as a free source for Twitter trends
        url = f"https://trends24.in/{country.lower().replace(' ', '-')}/"
        headers = {
            "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36"
        }

        resp = requests.get(url, headers=headers, timeout=15)
        resp.raise_for_status()

        soup = BeautifulSoup(resp.text, "html.parser")
        trends = []

        for item in soup.select(".trend-card__list-item"):
            link = item.select_one("a")
            if link:
                trends.append({
                    "source": "twitter_x",
                    "keyword": link.get_text(strip=True),
                    "url": link.get("href", ""),
                    "type": "trending_topic",
                    "fetched_at": datetime.utcnow().isoformat()
                })

        logger.info(f"Fetched {len(trends)} trends from X/Twitter via trends24.in")
        return trends

    except ImportError:
        logger.warning("beautifulsoup4 not installed, trying requests only")
        return fetch_x_trends_simple()
    except Exception as e:
        logger.error(f"X/Twitter trends error: {e}")
        return []


def fetch_x_trends_simple():
    """Fallback: simple regex-based X trend scraping."""
    try:
        import requests
        url = "https://trends24.in/"
        headers = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36"}
        resp = requests.get(url, headers=headers, timeout=15)
        # Basic text extraction
        import re
        trends = re.findall(r'class="trend[^"]*"[^>]*>([^<]+)<', resp.text)
        return [
            {"source": "twitter_x", "keyword": t.strip(), "fetched_at": datetime.utcnow().isoformat()}
            for t in trends if len(t.strip()) > 2
        ][:20]
    except Exception as e:
        logger.error(f"Simple X trends error: {e}")
        return []


def deduplicate_and_rank(all_items):
    """Deduplicate and rank fetched content by score/virality signals."""
    seen = set()
    unique = []

    for item in all_items:
        key = item.get("title", item.get("keyword", ""))[:80].lower().strip()
        if key and key not in seen:
            seen.add(key)
            unique.append(item)

    # Sort by score if available
    unique.sort(key=lambda x: x.get("score", 0), reverse=True)
    return unique


def main():
    logger.info("=== TREND FETCHER START ===")
    run_id = datetime.utcnow().strftime("%Y%m%d_%H%M%S")

    all_items = []

    # 1. Reddit memes
    reddit_posts = fetch_reddit_trending(limit_per_sub=10)
    all_items.extend(reddit_posts)

    # 2. Google Trends
    gtrends_items = fetch_google_trends()
    all_items.extend(gtrends_items)

    # 3. X/Twitter trends
    x_items = fetch_x_trending()
    all_items.extend(x_items)

    # Dedup + rank
    ranked = deduplicate_and_rank(all_items)

    # Save output
    output_file = OUTPUT_DIR / f"trends_{run_id}.json"
    output_data = {
        "run_id": run_id,
        "fetched_at": datetime.utcnow().isoformat(),
        "total_raw": len(all_items),
        "total_unique": len(ranked),
        "items": ranked
    }

    with open(output_file, "w") as f:
        json.dump(output_data, f, indent=2, ensure_ascii=False)

    logger.info(f"Output saved: {output_file}")
    print(str(output_file))  # stdout for pipeline chaining
    return output_file


if __name__ == "__main__":
    main()
