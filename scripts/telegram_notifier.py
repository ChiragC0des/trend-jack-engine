#!/usr/bin/env python3
"""
telegram_notifier.py — Send ad previews to Telegram for approval.
Sends images + hooks to your Telegram, you approve/reply.
"""

import json
import os
import sys
import logging
import requests
from pathlib import Path
from datetime import datetime

PROJECT_DIR = Path(__file__).parent.parent
OUTPUT_DIR = PROJECT_DIR / "output"
LOG_DIR = PROJECT_DIR / "logs"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.FileHandler(LOG_DIR / "telegram_notifier.log"),
        logging.StreamHandler()
    ]
)
logger = logging.getLogger(__name__)

TELEGRAM_TOKEN = os.environ.get("TELEGRAM_TOKEN", "")
TELEGRAM_CHAT_ID = os.environ.get("TELEGRAM_CHAT_ID", "")


def send_telegram_message(text, parse_mode="HTML"):
    """Send text message to Telegram."""
    if not TELEGRAM_TOKEN or not TELEGRAM_CHAT_ID:
        logger.error("Telegram credentials not set")
        return False

    url = f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/sendMessage"
    payload = {
        "chat_id": TELEGRAM_CHAT_ID,
        "text": text[:4096],  # Telegram limit
        "parse_mode": parse_mode
    }

    try:
        resp = requests.post(url, json=payload, timeout=30)
        resp.raise_for_status()
        logger.info(f"Message sent: {text[:80]}...")
        return True
    except Exception as e:
        logger.error(f"Telegram send error: {e}")
        return False


def send_telegram_photo(photo_path, caption=""):
    """Send image to Telegram."""
    if not TELEGRAM_TOKEN or not TELEGRAM_CHAT_ID:
        logger.error("Telegram credentials not set")
        return False

    url = f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/sendPhoto"

    try:
        with open(photo_path, "rb") as photo:
            files = {"photo": photo}
            data = {
                "chat_id": TELEGRAM_CHAT_ID,
                "caption": caption[:1024],
                "parse_mode": "HTML"
            }
            resp = requests.post(url, files=files, data=data, timeout=60)
            resp.raise_for_status()
        logger.info(f"Photo sent: {photo_path}")
        return True
    except Exception as e:
        logger.error(f"Telegram photo error: {e}")
        return False


def send_ad_manifest(manifest_file, ad_dir):
    """Send full ad manifest with images to Telegram for approval."""
    with open(manifest_file) as f:
        manifest = json.load(f)

    # Header
    header = f"""
<b>🔥 TREND-JACK AD BATCH #{manifest['run_id']}</b>
📅 {manifest['created_at'][:19]}
📊 {manifest['total_ads']} ads created

Review and reply:
✅ <b>publish</b> — Send all
🚫 <b>skip</b> — Skip this batch

(Auto-publishes in 30 min if no reply)
"""
    send_telegram_message(header)

    # Send each ad image with caption
    for ad_file in manifest.get("ad_files", []):
        ad_path = Path(ad_file)
        if ad_path.exists():
            platform = ad_path.stem.split("_")[-1] if "_" in ad_path.stem else "feed"
            caption = f"<b>Ad</b>: {ad_path.stem}\n<b>Platform</b>: {platform}\nReply ✅ to publish"
            send_telegram_photo(str(ad_path), caption)

    logger.info(f"Manifest sent to Telegram: {len(manifest.get('ad_files', []))} ads")


def main():
    # Find latest ad manifest
    ad_dirs = sorted(OUTPUT_DIR.glob("ads/*/"), reverse=True)
    if not ad_dirs:
        logger.error("No ad directories found")
        sys.exit(1)

    latest_dir = ad_dirs[0]
    manifest_file = latest_dir / "manifest.json"

    if not manifest_file.exists():
        logger.error(f"No manifest in {latest_dir}")
        sys.exit(1)

    send_ad_manifest(str(manifest_file), str(latest_dir))


if __name__ == "__main__":
    main()
