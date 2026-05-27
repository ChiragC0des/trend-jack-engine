#!/usr/bin/env python3
"""
run_pipeline.py — Main orchestrator for the Trend-Jack Ad Engine.
Runs the full pipeline: Fetch → Evaluate → Create → Notify → (optional) Publish

Usage:
    python3 run_pipeline.py                    # Full pipeline
    python3 run_pipeline.py --fetch-only       # Only fetch trends
    python3 run_pipeline.py --evaluate-only    # Only evaluate existing trends
    python3 run_pipeline.py --create-only      # Only create ads from evaluated
    python3 run_pipeline.py --skip-telegram    # Skip Telegram notification
    python3 run_pipeline.py --niches "coding,startup,AI"  # Custom niches
"""

import argparse
import json
import subprocess
import sys
import os
import logging
from pathlib import Path
from datetime import datetime

PROJECT_DIR = Path(__file__).parent.parent
SCRIPTS_DIR = PROJECT_DIR / "scripts"
OUTPUT_DIR = PROJECT_DIR / "output"
LOG_DIR = PROJECT_DIR / "logs"
LOG_DIR.mkdir(exist_ok=True)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.FileHandler(LOG_DIR / "pipeline.log"),
        logging.StreamHandler()
    ]
)
logger = logging.getLogger(__name__)

PYTHON = str(PROJECT_DIR / ".venv" / "bin" / "python3")


def run_script(script_name, extra_args=None):
    """Run a pipeline script and return its output path."""
    script_path = SCRIPTS_DIR / script_name
    if not script_path.exists():
        logger.error(f"Script not found: {script_path}")
        return None

    cmd = [PYTHON, str(script_path)]
    if extra_args:
        cmd.extend(extra_args)

    logger.info(f"Running: {' '.join(cmd)}")

    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=300,
            cwd=str(PROJECT_DIR)
        )

        if result.returncode != 0:
            logger.error(f"Script {script_name} failed (exit {result.returncode})")
            logger.error(f"STDERR: {result.stderr[-1000:]}")
            return None

        # Last line stdout = output file path
        output_lines = [l for l in result.stdout.strip().split("\n") if l.strip()]
        if output_lines:
            output_path = output_lines[-1]
            if Path(output_path).exists():
                logger.info(f"{script_name} output: {output_path}")
                return output_path

        return None

    except subprocess.TimeoutExpired:
        logger.error(f"Script {script_name} timed out")
        return None
    except Exception as e:
        logger.error(f"Error running {script_name}: {e}")
        return None


def pipeline_fetch(niches=None):
    """Stage 1: Fetch trending content."""
    logger.info("=" * 60)
    logger.info("STAGE 1: Fetching trending content...")
    args = []
    if niches:
        args.extend(["--niches", ",".join(niches)])
    return run_script("trend_fetcher.py", args)


def pipeline_evaluate(trends_file):
    """Stage 2: AI evaluate trends for ad potential."""
    logger.info("=" * 60)
    logger.info("STAGE 2: AI evaluating trends...")
    return run_script("ai_evaluator.py")


def pipeline_create():
    """Stage 3: Create ad images."""
    logger.info("=" * 60)
    logger.info("STAGE 3: Creating ad images...")
    return run_script("image_generator.py")


def pipeline_notify():
    """Stage 4: Send to Telegram for approval."""
    logger.info("=" * 60)
    logger.info("STAGE 4: Sending to Telegram for approval...")
    return run_script("telegram_notifier.py")


def save_run_summary(run_data):
    """Save pipeline run summary."""
    summary_file = OUTPUT_DIR / "run_history.jsonl"
    with open(summary_file, "a") as f:
        f.write(json.dumps(run_data) + "\n")
    logger.info(f"Run summary saved: {summary_file}")


def main():
    parser = argparse.ArgumentParser(description="Trend-Jack Ad Engine Pipeline")
    parser.add_argument("--fetch-only", action="store_true")
    parser.add_argument("--evaluate-only", action="store_true")
    parser.add_argument("--create-only", action="store_true")
    parser.add_argument("--skip-telegram", action="store_true")
    parser.add_argument("--niches", type=str, help="Comma-separated list of niches")
    args = parser.parse_args()

    run_start = datetime.utcnow()
    run_id = run_start.strftime("%Y%m%d_%H%M%S")
    niches = [n.strip() for n in args.niches.split(",")] if args.niches else None

    run_data = {
        "run_id": run_id,
        "started_at": run_start.isoformat(),
        "stages": {}
    }

    logger.info("=" * 60)
    logger.info(f"🔥 TREND-JACK AD ENGINE — RUN #{run_id}")
    logger.info("=" * 60)

    if args.fetch_only:
        trends_file = pipeline_fetch(niches)
        run_data["stages"]["fetch"] = {"output": str(trends_file)}
        save_run_summary(run_data)
        return

    if args.evaluate_only:
        pipeline_evaluate(None)
        save_run_summary(run_data)
        return

    if args.create_only:
        pipeline_create()
        save_run_summary(run_data)
        return

    # Full pipeline
    # Stage 1: Fetch
    trends_file = pipeline_fetch(niches)
    if not trends_file:
        logger.error("Pipeline failed at fetch stage")
        run_data["status"] = "failed_fetch"
        save_run_summary(run_data)
        sys.exit(1)
    run_data["stages"]["fetch"] = {"output": str(trends_file)}

    # Stage 2: Evaluate
    evaluated_file = pipeline_evaluate(trends_file)
    if not evaluated_file:
        logger.warning("Pipeline: no items scored high enough")
        run_data["status"] = "no_high_scores"
        save_run_summary(run_data)
        sys.exit(0)
    run_data["stages"]["evaluate"] = {"output": str(evaluated_file)}

    # Stage 3: Create ads
    ads_dir = pipeline_create()
    if not ads_dir:
        logger.warning("Pipeline: no ad images created")
        run_data["status"] = "no_ads_created"
        save_run_summary(run_data)
        sys.exit(0)
    run_data["stages"]["create"] = {"output": str(ads_dir)}

    # Stage 4: Telegram notification
    if not args.skip_telegram:
        pipeline_notify()
        run_data["stages"]["notify"] = {"status": "sent"}
    else:
        run_data["stages"]["notify"] = {"status": "skipped"}

    # Done
    run_data["status"] = "completed"
    run_data["completed_at"] = datetime.utcnow().isoformat()
    save_run_summary(run_data)

    logger.info("=" * 60)
    logger.info(f"✅ PIPELINE COMPLETE — Run #{run_id}")
    logger.info(f"📁 Ads dir: {ads_dir}")
    logger.info("Check Telegram for approval prompts")
    logger.info("=" * 60)


if __name__ == "__main__":
    main()
