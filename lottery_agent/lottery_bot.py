#!/usr/bin/env python3
"""
Lottery.ie automation agent — family syndicate (Madigan Lotto)
Plays 5 fixed lines on lottery.ie and sends the confirmation screenshot
to the Madigan Lotto WhatsApp group.
"""

import os
import sys
import json
import logging
from datetime import datetime
from pathlib import Path
from typing import Optional

from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeout

try:
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).parent / ".env")
except ImportError:
    pass

EMAIL          = os.environ.get("LOTTERY_EMAIL", "")
PASSWORD       = os.environ.get("LOTTERY_PASSWORD", "")
WHATSAPP_GROUP = os.environ.get("WHATSAPP_GROUP", "Madigan Lotto")
HEADLESS       = os.environ.get("LOTTERY_HEADLESS", "false").lower() == "true"

SCRIPT_DIR           = Path(__file__).parent
TICKETS_FILE         = SCRIPT_DIR / "tickets_family.json"
SCREENSHOT_DIR       = SCRIPT_DIR / "screenshots"
WHATSAPP_SESSION_DIR = SCRIPT_DIR / "whatsapp_session"
LOG_FILE             = SCRIPT_DIR / "lottery_agent.log"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[logging.StreamHandler(), logging.FileHandler(LOG_FILE)],
)
log = logging.getLogger(__name__)


def main():
    if not EMAIL or not PASSWORD:
        log.error("LOTTERY_EMAIL and LOTTERY_PASSWORD must be set in .env")
        sys.exit(1)

    SCREENSHOT_DIR.mkdir(exist_ok=True)
    WHATSAPP_SESSION_DIR.mkdir(exist_ok=True)

    with open(TICKETS_FILE) as f:
        tickets = json.load(f)

    log.info("=== Starting lottery agent ===")
    confirmation = play_lottery(tickets)
    if confirmation:
        send_whatsapp(confirmation)
    log.info("=== Done ===")


# ---------------------------------------------------------------------------
# Phase 1: Play lottery
# ---------------------------------------------------------------------------

def play_lottery(tickets: dict) -> Optional[Path]:
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=HEADLESS)
        page = browser.new_page(viewport={"width": 1280, "height": 900})
        try:
            _dismiss_consent_and_login(page)
            return _play(page, tickets)
        except Exception as exc:
            _screenshot(page, "error")
            log.error("Failed: %s", exc, exc_info=True)
            return None
        finally:
            browser.close()


def _dismiss_consent_and_login(page):
    log.info("Opening login page...")
    page.goto("https://www.lottery.ie/account/login", wait_until="domcontentloaded", timeout=30_000)
    _screenshot(page, "01_login")

    # Dismiss consent banner
    try:
        page.click('button:has-text("Allow Selection")', timeout=5_000)
        log.info("Dismissed consent banner.")
    except PlaywrightTimeout:
        pass

    _screenshot(page, "02_after_consent")

    # Log in
    page.fill("#username", EMAIL)
    page.fill("#password", PASSWORD)
    page.click('button[type="submit"]')
    page.wait_for_load_state("networkidle", timeout=30_000)
    _screenshot(page, "03_after_login")

    if "login" in page.url.lower():
        raise RuntimeError("Login failed — still on login page.")
    log.info("Logged in. URL: %s", page.url)


def _play(page, tickets: dict) -> Optional[Path]:
    lines      = tickets["lines"]
    lotto_plus = tickets.get("lotto_plus", False)

    log.info("Navigating to Lotto play page...")
    page.goto("https://www.lottery.ie/draw-games/lotto", wait_until="domcontentloaded", timeout=30_000)
    page.wait_for_load_state("networkidle", timeout=15_000)
    _screenshot(page, "04_lotto_page")

    # --- number entry, lotto plus, purchase will be filled in once we see the page ---

    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    path = SCREENSHOT_DIR / f"confirmation_{ts}.png"
    page.screenshot(path=str(path), full_page=True)
    return path


# ---------------------------------------------------------------------------
# Phase 2: WhatsApp
# ---------------------------------------------------------------------------

def send_whatsapp(screenshot_path: Path):
    log.info("Opening WhatsApp Web...")
    with sync_playwright() as p:
        context = p.chromium.launch_persistent_context(
            str(WHATSAPP_SESSION_DIR),
            headless=False,
            viewport={"width": 1280, "height": 900},
        )
        page = context.new_page()
        try:
            page.goto("https://web.whatsapp.com", wait_until="domcontentloaded", timeout=30_000)
            page.wait_for_selector('[data-testid="chat-list"], canvas[aria-label="Scan me!"]', timeout=60_000)

            if page.query_selector('canvas[aria-label="Scan me!"]'):
                log.info("QR code shown — scan with your phone (waiting up to 2 minutes)...")
                page.wait_for_selector('[data-testid="chat-list"]', timeout=120_000)

            _screenshot(page, "08_whatsapp_loaded")

            page.click('[data-testid="search"]', timeout=10_000)
            page.fill('[data-testid="search-input"]', WHATSAPP_GROUP)
            page.wait_for_timeout(2_000)
            page.click(f'span[title="{WHATSAPP_GROUP}"]', timeout=10_000)
            page.wait_for_timeout(1_000)
            _screenshot(page, "09_whatsapp_group")

            page.click('[data-testid="attach-menu-plus"]', timeout=10_000)
            page.wait_for_timeout(500)

            with page.expect_file_chooser(timeout=10_000) as fc:
                page.click('[data-testid="mi-attach-media"]', timeout=5_000)
            fc.value.set_files(str(screenshot_path))
            page.wait_for_timeout(2_000)

            page.click('[data-testid="send"]', timeout=10_000)
            page.wait_for_timeout(3_000)
            _screenshot(page, "10_whatsapp_sent")
            log.info("Screenshot sent to '%s'.", WHATSAPP_GROUP)
        except Exception as exc:
            _screenshot(page, "whatsapp_error")
            log.error("WhatsApp failed: %s", exc, exc_info=True)
        finally:
            context.close()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _screenshot(page, name: str):
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    try:
        page.screenshot(path=str(SCREENSHOT_DIR / f"{name}_{ts}.png"), full_page=True)
    except Exception:
        pass


if __name__ == "__main__":
    main()
