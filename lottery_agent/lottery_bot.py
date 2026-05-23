#!/usr/bin/env python3
"""
Lottery.ie automation agent — family syndicate (Madigan Lotto)
Plays fixed lines from tickets_family.json and sends the confirmation
screenshot to the Madigan Lotto WhatsApp group.

Scheduled: Wednesday and Saturday at 17:00 Irish time.
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
HEADLESS       = os.environ.get("LOTTERY_HEADLESS", "false").lower() == "true"
WHATSAPP_GROUP = os.environ.get("WHATSAPP_GROUP", "Madigan Lotto")

BASE_URL             = "https://www.lottery.ie"
SCRIPT_DIR           = Path(__file__).parent
TICKETS_FILE         = SCRIPT_DIR / "tickets_family.json"
SCREENSHOT_DIR       = SCRIPT_DIR / "screenshots"
WHATSAPP_SESSION_DIR = SCRIPT_DIR / "whatsapp_session"
LOG_FILE             = SCRIPT_DIR / "lottery_agent.log"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.StreamHandler(),
        logging.FileHandler(LOG_FILE),
    ],
)
log = logging.getLogger(__name__)


def main():
    if not EMAIL or not PASSWORD:
        log.error("LOTTERY_EMAIL and LOTTERY_PASSWORD must be set.")
        sys.exit(1)

    SCREENSHOT_DIR.mkdir(exist_ok=True)
    WHATSAPP_SESSION_DIR.mkdir(exist_ok=True)

    log.info("=== Lottery agent starting ===")
    tickets = load_tickets()

    confirmation_path = play_lottery(tickets)
    if confirmation_path:
        send_whatsapp(confirmation_path)

    log.info("=== Lottery agent finished ===")


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

def load_tickets() -> dict:
    if not TICKETS_FILE.exists():
        log.error("Tickets file not found: %s", TICKETS_FILE)
        sys.exit(1)
    with open(TICKETS_FILE) as f:
        return json.load(f)


# ---------------------------------------------------------------------------
# Phase 1 — Play lottery
# ---------------------------------------------------------------------------

def play_lottery(tickets: dict) -> Optional[Path]:
    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=HEADLESS,
            args=["--disable-blink-features=AutomationControlled"],
        )
        context = browser.new_context(
            viewport={"width": 1280, "height": 900},
            user_agent=(
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/124.0.0.0 Safari/537.36"
            ),
        )
        page = context.new_page()
        try:
            login(page)
            return enter_and_confirm(page, tickets)
        except Exception as exc:
            screenshot(page, "fatal_lottery_error")
            log.error("Lottery play failed: %s", exc, exc_info=True)
            log.error("Check screenshots/ for a visual of what happened.")
            return None
        finally:
            context.close()
            browser.close()


def login(page):
    log.info("Logging in...")
    page.goto(f"{BASE_URL}/account/login", wait_until="domcontentloaded", timeout=30_000)
    screenshot(page, "01_login_page")

    for sel in [
        'button:has-text("Allow Selection")',
        'button:has-text("Allow selection")',
        'button:has-text("Accept")',
        '#onetrust-accept-btn-handler',
    ]:
        try:
            page.click(sel, timeout=3_000)
            log.info("Dismissed consent banner.")
            break
        except PlaywrightTimeout:
            pass

    page.fill('#username', EMAIL)
    page.fill('#password', PASSWORD)
    screenshot(page, "02_credentials_filled")

    page.click(
        'button[type="submit"], input[type="submit"], '
        'button:has-text("Log In"), button:has-text("Sign In"), button:has-text("Login")'
    )
    page.wait_for_load_state("networkidle", timeout=30_000)
    screenshot(page, "03_after_login")

    if "login" in page.url.lower():
        raise RuntimeError("Login failed — still on login page. Check credentials.")
    log.info("Logged in. URL: %s", page.url)


def enter_and_confirm(page, tickets: dict) -> Optional[Path]:
    lines      = tickets["lines"]
    lotto_plus = tickets.get("lotto_plus", False)

    log.info("Navigating to Lotto play page...")
    page.goto(f"{BASE_URL}/lotto/play", wait_until="domcontentloaded", timeout=30_000)
    page.wait_for_load_state("networkidle", timeout=15_000)
    screenshot(page, "04_lotto_play_page")

    for i, line in enumerate(lines):
        log.info("Entering line %d: %s", i + 1, line)
        _enter_line(page, i, line)
        screenshot(page, f"05_line_{i + 1}_entered")

    if lotto_plus:
        _enable_lotto_plus(page)

    screenshot(page, "06_before_purchase")
    _confirm_purchase(page)

    # Check for insufficient funds warning
    page_text = page.inner_text("body").lower()
    if any(w in page_text for w in ("insufficient", "not enough credit", "top up", "add funds")):
        log.warning("Insufficient funds detected — please top up your account.")

    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    path = SCREENSHOT_DIR / f"confirmation_{ts}.png"
    page.screenshot(path=str(path), full_page=True)
    log.info("Confirmation screenshot saved: %s", path)
    screenshot(page, "07_confirmation")
    return path


def _enter_line(page, line_index: int, numbers: list):
    if line_index > 0:
        for sel in [
            'button:has-text("Add Line")',
            'button:has-text("+ Add Line")',
            'button:has-text("Add another line")',
            '[data-testid="add-line"]',
            '.add-line-btn',
        ]:
            try:
                page.click(sel, timeout=3_000)
                page.wait_for_timeout(500)
                break
            except PlaywrightTimeout:
                pass

    for number in numbers:
        _click_number(page, line_index, number)


def _click_number(page, line_index: int, number: int):
    selectors = [
        f'.line:nth-child({line_index + 1}) button[data-number="{number}"]',
        f'.line:nth-child({line_index + 1}) [aria-label="{number}"]',
        f'[data-line="{line_index}"] button[data-number="{number}"]',
        f'button[data-number="{number}"]:not(.selected)',
        f'[aria-label="Number {number}"]',
    ]
    for sel in selectors:
        try:
            page.click(sel, timeout=2_000)
            return
        except PlaywrightTimeout:
            pass

    raise RuntimeError(
        f"Could not click number {number} on line {line_index + 1}. "
        "See screenshots — the number entry UI likely uses different selectors."
    )


def _enable_lotto_plus(page):
    log.info("Enabling Lotto Plus...")
    for sel in [
        'label:has-text("Lotto Plus")',
        'button:has-text("Lotto Plus")',
        'input[name*="plus"][type="checkbox"]',
        '[data-testid="lotto-plus"]',
        '.lotto-plus-toggle',
    ]:
        try:
            page.click(sel, timeout=3_000)
            log.info("Lotto Plus enabled.")
            return
        except PlaywrightTimeout:
            pass
    log.warning("Could not find Lotto Plus toggle — skipping.")


def _confirm_purchase(page):
    log.info("Confirming purchase...")
    for sel in [
        'button:has-text("Buy")',
        'button:has-text("Play Now")',
        'button:has-text("Purchase")',
        'button:has-text("Confirm")',
        'button:has-text("Pay")',
        '[data-testid="buy-btn"]',
    ]:
        try:
            page.click(sel, timeout=5_000)
            page.wait_for_load_state("networkidle", timeout=30_000)
            log.info("Purchase confirmed.")
            return
        except PlaywrightTimeout:
            pass
    raise RuntimeError(
        "Could not find a purchase/confirm button. See screenshot 06_before_purchase."
    )


# ---------------------------------------------------------------------------
# Phase 2 — WhatsApp
# ---------------------------------------------------------------------------

def send_whatsapp(screenshot_path: Path):
    log.info("Opening WhatsApp Web...")
    with sync_playwright() as p:
        # Persistent context saves the WhatsApp login between runs.
        # First run only: a QR code will appear — scan it with your phone.
        context = p.chromium.launch_persistent_context(
            str(WHATSAPP_SESSION_DIR),
            headless=False,
            viewport={"width": 1280, "height": 900},
            args=["--disable-blink-features=AutomationControlled"],
        )
        page = context.new_page()
        try:
            _whatsapp_send(page, screenshot_path)
        except Exception as exc:
            screenshot(page, "fatal_whatsapp_error")
            log.error("WhatsApp send failed: %s", exc, exc_info=True)
        finally:
            context.close()


def _whatsapp_send(page, screenshot_path: Path):
    page.goto("https://web.whatsapp.com", wait_until="domcontentloaded", timeout=30_000)

    log.info("Waiting for WhatsApp Web to load...")
    page.wait_for_selector(
        '[data-testid="chat-list"], canvas[aria-label="Scan me!"], #app .landing-main',
        timeout=60_000,
    )

    if page.query_selector('canvas[aria-label="Scan me!"], #app .landing-main'):
        log.info("QR code shown — please scan with your phone (waiting up to 2 minutes)...")
        page.wait_for_selector('[data-testid="chat-list"]', timeout=120_000)
        log.info("WhatsApp Web authenticated.")

    screenshot(page, "08_whatsapp_loaded")

    # Search for the group
    log.info("Searching for group '%s'...", WHATSAPP_GROUP)
    page.click('[data-testid="search"], [data-icon="search"]', timeout=10_000)
    page.wait_for_timeout(500)
    page.fill(
        '[data-testid="search-input"], input[title="Search or start new chat"]',
        WHATSAPP_GROUP,
    )
    page.wait_for_timeout(2_000)
    screenshot(page, "09_whatsapp_search")

    page.click(
        f'[title="{WHATSAPP_GROUP}"], span[title="{WHATSAPP_GROUP}"]',
        timeout=10_000,
    )
    page.wait_for_timeout(1_000)
    screenshot(page, "10_whatsapp_group_open")

    # Open the attachment menu
    log.info("Attaching screenshot...")
    page.click(
        '[data-testid="attach-menu-plus"], [data-icon="attach-menu-plus"]',
        timeout=10_000,
    )
    page.wait_for_timeout(500)

    # Upload via the Photos & Videos file input
    with page.expect_file_chooser(timeout=10_000) as fc_info:
        page.click(
            '[data-testid="mi-attach-media"], span:has-text("Photos & videos"), '
            'li:has-text("Photos")',
            timeout=5_000,
        )
    fc_info.value.set_files(str(screenshot_path))
    page.wait_for_timeout(2_000)
    screenshot(page, "11_whatsapp_image_attached")

    # Send
    page.click('[data-testid="send"], [data-icon="send"]', timeout=10_000)
    page.wait_for_timeout(3_000)
    screenshot(page, "12_whatsapp_sent")
    log.info("Screenshot sent to '%s'.", WHATSAPP_GROUP)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def screenshot(page, name: str):
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    path = SCREENSHOT_DIR / f"{name}_{ts}.png"
    try:
        page.screenshot(path=str(path), full_page=True)
    except Exception:
        pass


if __name__ == "__main__":
    main()
