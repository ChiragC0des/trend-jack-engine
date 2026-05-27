#!/usr/bin/env python3
"""
image_generator.py — Create ad images from trending content.
Supports: Google Gemini Imagen/Nano Banana API or OpenAI DALL-E.
Two modes:
1. Download meme image + overlay hook text (Pillow) — always works
2. Generate new AI image from prompt — via configured provider
Outputs: ad-ready images in output/ads/
"""

import json
import os
import sys
import io
import textwrap
import logging
import requests
from pathlib import Path
from datetime import datetime
from PIL import Image, ImageDraw, ImageFont

PROJECT_DIR = Path(__file__).parent.parent
OUTPUT_DIR = PROJECT_DIR / "output"
ADS_DIR = OUTPUT_DIR / "ads"
LOG_DIR = PROJECT_DIR / "logs"
ADS_DIR.mkdir(parents=True, exist_ok=True)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.FileHandler(LOG_DIR / "image_generator.log"),
        logging.StreamHandler()
    ]
)
logger = logging.getLogger(__name__)

# --- PROVIDER CONFIG ---
PROVIDER = os.environ.get("PROVIDER", "google").lower()

# Google Gemini
GOOGLE_API_KEY = os.environ.get("GOOGLE_API_KEY", "")
GOOGLE_IMAGE_MODEL = os.environ.get("GOOGLE_IMAGE_MODEL", "imagen-3.0-generate-002")
# Alternative: "gemini-2.5-flash-image" for Nano Banana

# OpenAI
OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY", "")
OPENAI_BASE_URL = os.environ.get("OPENAI_BASE_URL", "https://api.openai.com/v1")
OPENAI_IMAGE_MODEL = os.environ.get("OPENAI_IMAGE_MODEL", "dall-e-3")

# Font paths
FONT_PATHS = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/freefont/FreeSansBold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    "/usr/share/fonts/truetype/noto/NotoSans-Bold.ttf",
]

HINDI_FONT_PATHS = [
    "/usr/share/fonts/truetype/noto/NotoSansDevanagari-Bold.ttf",
    "/usr/share/fonts/truetype/noto/NotoSansDevanagari-Regular.ttf",
    "/usr/share/fonts/freefont/FreeSans.ttf",
]

BRAND_TEXT = os.environ.get("BRAND_TEXT", "seepmedia.ai")


def find_font(paths, size=32):
    """Find first available font from list."""
    for p in paths:
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except:
                continue
    return ImageFont.load_default()


def download_image(url, timeout=15):
    """Download image from URL and return PIL Image."""
    try:
        headers = {"User-Agent": "Mozilla/5.0 (TrendJackEngine/1.0)"}
        resp = requests.get(url, headers=headers, timeout=timeout, stream=True)
        resp.raise_for_status()
        img = Image.open(io.BytesIO(resp.content))
        return img.convert("RGB")
    except Exception as e:
        logger.error(f"Failed to download image from {url}: {e}")
        return None


def add_text_overlay(img, text_en, text_hi=""):
    """Overlay hook text on image with style."""
    draw = ImageDraw.Draw(img)
    w, h = img.size

    font_size = max(24, min(48, w // 15))
    font_en = find_font(FONT_PATHS, font_size)
    font_hi = find_font(HINDI_FONT_PATHS, int(font_size * 0.9))

    margin = 20
    max_text_width = w - (margin * 2)
    wrapped_en = textwrap.wrap(text_en, width=max(10, (max_text_width // (font_size // 2))))
    wrapped_hi = textwrap.wrap(text_hi, width=max(10, (max_text_width // (font_size // 2)))) if text_hi else []

    line_height = font_size + 8
    text_block_height = (len(wrapped_en) + len(wrapped_hi)) * line_height + margin * 2

    # Semi-transparent overlay at bottom
    overlay = Image.new("RGB", (w, h), (0, 0, 0))
    overlay_draw = ImageDraw.Draw(overlay)
    overlay_draw.rectangle([(0, h - text_block_height), (w, h)], fill=(0, 0, 0))
    img = Image.blend(img, overlay, alpha=0.6)

    # Draw text
    draw = ImageDraw.Draw(img)
    y = h - text_block_height + margin

    for line in wrapped_hi:
        bbox = draw.textbbox((0, 0), line, font=font_hi)
        tw = bbox[2] - bbox[0]
        x = (w - tw) // 2
        draw.text((x + 2, y + 2), line, font=font_hi, fill=(0, 0, 0))
        draw.text((x, y), line, font=font_hi, fill=(255, 200, 50))
        y += line_height

    for line in wrapped_en:
        bbox = draw.textbbox((0, 0), line, font=font_en)
        tw = bbox[2] - bbox[0]
        x = (w - tw) // 2
        draw.text((x + 2, y + 2), line, font=font_en, fill=(0, 0, 0))
        draw.text((x, y), line, font=font_en, fill=(255, 255, 255))
        y += line_height

    return img


def add_brand_watermark(img, brand_text=BRAND_TEXT):
    """Add small brand watermark."""
    draw = ImageDraw.Draw(img)
    w, h = img.size
    font = find_font(FONT_PATHS, max(14, w // 40))
    bbox = draw.textbbox((0, 0), brand_text, font=font)
    tw = bbox[2] - bbox[0]
    x = w - tw - 10
    y = h - 30
    draw.text((x + 1, y + 1), brand_text, font=font, fill=(0, 0, 0))
    draw.text((x, y), brand_text, font=font, fill=(200, 200, 200))
    return img


# --- GOOGLE GEMINI IMAGE GENERATION ---

def generate_image_google_imagen(prompt, aspect_ratio="1:1"):
    """Generate image using Google Imagen 3 via Gemini API."""
    if not GOOGLE_API_KEY:
        logger.error("GOOGLE_API_KEY not set")
        return None

    url = f"https://generativelanguage.googleapis.com/v1beta/models/{GOOGLE_IMAGE_MODEL}:predict?key={GOOGLE_API_KEY}"

    payload = {
        "instances": [{"prompt": prompt}],
        "parameters": {
            "sampleCount": 1,
            "aspectRatio": aspect_ratio,  # "1:1", "16:9", "9:16", "4:3"
            "personGeneration": "allow_adult"
        }
    }

    try:
        resp = requests.post(url, json=payload, timeout=120)
        resp.raise_for_status()
        result = resp.json()

        # Extract base64 image from response
        predictions = result.get("predictions", [])
        if not predictions:
            logger.error("No predictions in Imagen response")
            return None

        import base64
        img_data = predictions[0].get("bytesBase64Encoded", "")
        if img_data:
            img_bytes = base64.b64decode(img_data)
            return Image.open(io.BytesIO(img_bytes)).convert("RGB")

        logger.error("No image data in Imagen response")
        return None

    except requests.exceptions.HTTPError as e:
        logger.error(f"Imagen API error: {e} - {e.response.text[:500] if e.response else ''}")
        return None
    except Exception as e:
        logger.error(f"Imagen generation error: {e}")
        return None


def generate_image_google_gemini_flash(prompt):
    """Generate image using Gemini 2.5 Flash Image (Nano Banana) via Gemini API."""
    if not GOOGLE_API_KEY:
        logger.error("GOOGLE_API_KEY not set")
        return None

    url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp-image-generation:generateContent?key={GOOGLE_API_KEY}"

    payload = {
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {
            "responseModalities": ["TEXT", "IMAGE"]
        }
    }

    try:
        resp = requests.post(url, json=payload, timeout=120)
        resp.raise_for_status()
        result = resp.json()

        import base64
        candidates = result.get("candidates", [])
        if not candidates:
            return None

        parts = candidates[0].get("content", {}).get("parts", [])
        for part in parts:
            inline = part.get("inlineData", {})
            if inline:
                img_data = inline.get("data", "")
                mime = inline.get("mimeType", "image/png")
                if img_data:
                    img_bytes = base64.b64decode(img_data)
                    return Image.open(io.BytesIO(img_bytes)).convert("RGB")

        logger.error("No image in Gemini Flash response")
        return None

    except requests.exceptions.HTTPError as e:
        logger.error(f"Gemini Flash Image error: {e} - {e.response.text[:500] if e.response else ''}")
        return None
    except Exception as e:
        logger.error(f"Gemini Flash Image error: {e}")
        return None


# --- OPENAI IMAGE GENERATION ---

def generate_image_openai(prompt, size="1024x1024"):
    """Generate image using OpenAI DALL-E."""
    if not OPENAI_API_KEY:
        logger.error("OPENAI_API_KEY not set")
        return None

    headers = {
        "Authorization": f"Bearer {OPENAI_API_KEY}",
        "Content-Type": "application/json"
    }

    payload = {
        "model": OPENAI_IMAGE_MODEL,
        "prompt": prompt,
        "n": 1,
        "size": size,
        "quality": "standard"
    }

    try:
        resp = requests.post(
            f"{OPENAI_BASE_URL}/images/generations",
            headers=headers,
            json=payload,
            timeout=120
        )
        resp.raise_for_status()
        result = resp.json()
        image_url = result["data"][0]["url"]
        return download_image(image_url)
    except Exception as e:
        logger.error(f"OpenAI image generation error: {e}")
        return None


# --- UNIFIED IMAGE GENERATION ---

def generate_ai_image(prompt, aspect_ratio="1:1"):
    """Generate image using configured provider."""
    ad_prompt = (
        f"Create a viral meme-style advertisement image: {prompt}. "
        f"Bold colors, attention-grabbing composition, space at bottom for text overlay, "
        f"modern design, high contrast, professional quality."
    )

    if PROVIDER == "google":
        logger.info(f"Generating image with Google ({GOOGLE_IMAGE_MODEL})")
        # Try Imagen first, fall back to Gemini Flash
        img = generate_image_google_imagen(ad_prompt, aspect_ratio)
        if img is None and GOOGLE_IMAGE_MODEL != "gemini-2.5-flash-image":
            logger.info("Falling back to Gemini 2.5 Flash Image")
            img = generate_image_google_gemini_flash(ad_prompt)
        return img
    else:
        logger.info(f"Generating image with OpenAI ({OPENAI_IMAGE_MODEL})")
        size_map = {"1:1": "1024x1024", "16:9": "1792x1024", "9:16": "1024x1792"}
        return generate_image_openai(ad_prompt, size_map.get(aspect_ratio, "1024x1024"))


# --- AD CREATION ---

PLATFORM_SIZES = {
    "ig_feed": (1080, 1080),
    "ig_story": (1080, 1920),
    "fb_feed": (1200, 630),
    "whatsapp": (800, 800),
}

GEMINI_ASPECT_RATIOS = {
    "ig_feed": "1:1",
    "ig_story": "9:16",
    "fb_feed": "16:9",
    "whatsapp": "1:1",
}


def create_ad_variations(item, output_dir):
    """Create multiple ad variations for an item."""
    created = []

    source_url = item.get("url", "")
    original_img = None

    if source_url and source_url.endswith(('.jpg', '.jpeg', '.png', '.gif', '.webp')):
        original_img = download_image(source_url)

    hook_en = item.get("hook_en", item.get("title", ""))
    hook_hi = item.get("hook_hi", "")
    niche = item.get("niche_fit", "general")

    if original_img:
        # Mode 1: Overlay text on meme image
        for platform_name, target_size in PLATFORM_SIZES.items():
            try:
                img = original_img.copy()
                img = img.resize(target_size, Image.LANCZOS)
                img = add_text_overlay(img, hook_en, hook_hi)
                img = add_brand_watermark(img, BRAND_TEXT)

                slug = f"{niche.replace(' ', '_')[:30]}_{platform_name}"
                filepath = output_dir / f"{slug}.jpg"
                img.save(filepath, "JPEG", quality=90)
                created.append(str(filepath))
                logger.info(f"Created: {filepath}")
            except Exception as e:
                logger.error(f"Error creating {platform_name}: {e}")

    else:
        # Mode 2: Generate AI image from hook text
        for platform_name, target_size in PLATFORM_SIZES.items():
            try:
                aspect = GEMINI_ASPECT_RATIOS.get(platform_name, "1:1")
                prompt = f"{hook_en} - {niche} meme ad, {platform_name} format"

                ai_img = generate_ai_image(prompt, aspect)
                if ai_img is None:
                    logger.warning(f"Skipping {platform_name} — image generation failed")
                    continue

                img = ai_img.resize(target_size, Image.LANCZOS)
                img = add_text_overlay(img, hook_en, hook_hi)
                img = add_brand_watermark(img, BRAND_TEXT)

                slug = f"ai_{niche.replace(' ', '_')[:30]}_{platform_name}"
                filepath = output_dir / f"{slug}.jpg"
                img.save(filepath, "JPEG", quality=90)
                created.append(str(filepath))
                logger.info(f"Created AI ad: {filepath}")

            except Exception as e:
                logger.error(f"Error creating AI {platform_name}: {e}")

    return created


def main():
    run_id = datetime.utcnow().strftime("%Y%m%d_%H%M%S")
    logger.info(f"Image Provider: {PROVIDER}")

    # Find latest evaluated file
    eval_files = sorted(OUTPUT_DIR.glob("evaluated_*.json"), reverse=True)
    if not eval_files:
        logger.error("No evaluated file found. Run ai_evaluator.py first.")
        sys.exit(1)

    input_file = eval_files[0]
    logger.info(f"Creating ads from: {input_file}")

    with open(input_file) as f:
        data = json.load(f)

    items = data.get("items", [])
    logger.info(f"Processing {len(items)} scored items")

    ad_run_dir = ADS_DIR / run_id
    ad_run_dir.mkdir(parents=True, exist_ok=True)

    all_created = []
    for item in items[:5]:
        created = create_ad_variations(item, ad_run_dir)
        all_created.extend(created)

    manifest = {
        "run_id": run_id,
        "provider": PROVIDER,
        "created_at": datetime.utcnow().isoformat(),
        "total_ads": len(all_created),
        "ad_files": all_created,
        "source_file": str(input_file)
    }

    manifest_file = ad_run_dir / "manifest.json"
    with open(manifest_file, "w") as f:
        json.dump(manifest, f, indent=2)

    logger.info(f"Created {len(all_created)} ad images in {ad_run_dir}")
    print(str(ad_run_dir))
    return ad_run_dir


if __name__ == "__main__":
    main()
