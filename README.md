# Trend-Jack Engine

AI-powered meme-to-ad pipeline. Fetches trending content from Reddit, Google Trends, and X/Twitter, scores it with Gemini/OpenAI, and generates viral ad images with text overlays.

## Pipeline

```
FETCH -> EVALUATE -> CREATE -> NOTIFY -> PUBLISH
```

1. **Fetch** — Scrapes hot posts from 10 meme subreddits, Google Trends (India), and X/Twitter trending
2. **Evaluate** — Gemini/Opentor scores each trend 1-10 for ad potential, generates Hindi + English hooks
3. **Create** — Generates ad images: downloads meme + overlays hook text (Pillow), or generates new AI images (Gemini Imagen 3 / Nano Banana / DALL-E)
4. **Notify** — Sends ad previews to Telegram for approval
5. **Publish** — (Optional) Publishes approved ads via n8n or Upload-Post API

## Setup

```bash
git clone https://github.com/ChiragC0des/trend-jack-engine.git
cd trend-jack-engine

python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

cp .env.example .env
# Edit .env with your API keys

# Run full pipeline
python3 scripts/run_pipeline.py

# Or run individual stages
python3 scripts/run_pipeline.py --fetch-only
python3 scripts/run_pipeline.py --evaluate-only
python3 scripts/run_pipeline.py --create-only
```

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PROVIDER` | No | `google` | AI provider: `google` or `openai` |
| `GOOGLE_API_KEY` | Yes* | — | Gemini API key (free at https://aistudio.google.com/app/apikey) |
| `OPENAI_API_KEY` | Yes* | — | OpenAI API key (if using OpenAI) |
| `TELEGRAM_TOKEN` | No | — | Telegram bot token for approval notifications |
| `TELEGRAM_CHAT_ID` | No | — | Telegram chat ID |
| `REDDIT_CLIENT_ID` | No | — | Reddit API (for meme fetching) |
| `REDDIT_CLIENT_SECRET` | No | — | Reddit API |
| `MIN_AD_SCORE` | No | `7` | Minimum ad score threshold (1-10) |
| `BRAND_TEXT` | No | `seepmedia.ai` | Brand watermark text |

*One of GOOGLE_API_KEY or OPENAI_API_KEY is required.

## Provider: Google Gemini (Default)

- **Free tier**: 500 requests/day
- **Image generation**: Imagen 3 or Nano Banana (Gemini 2.5 Flash Image)
- **Text generation**: Gemini 2.0 Flash
- **Advantage over Opentor**: Free tier, better text rendering on images, Hindi support

## Scripts

| Script | Purpose |
|--------|---------|
| `scripts/trend_fetcher.py` | Scrape Reddit + Google Trends + X/Twitter |
| `scripts/ai_evaluator.py` | Score trends, generate hooks (Hindi + English) |
| `scripts/image_generator.py` | Generate ad images with text overlays |
| `scripts/telegram_notifier.py` | Send to Telegram for approval |
| `scripts/run_pipeline.py` | Full pipeline orchestrator |

## Requirements

- Python 3.10+
- Google Gemini API key (free) or OpenAI API key
- Telegram bot (optional, for approval flow)
- Reddit API credentials (optional, for meme fetching)

## License

MIT
