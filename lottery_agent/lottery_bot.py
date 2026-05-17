#!/usr/bin/env python3
"""
lottery.ie automation agent
Logs in and replays the last 3 purchased tickets.
Meant to be invoked by a scheduler (cron / Task Scheduler) on Wed & Sat at 17:00.
"""

import os
import sys
import time
import logging
from datetime import datetime
from pathlib import Path

from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeout

try:
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).parent / ".env")
except ImportError:
    pass  # dotenv is optional; env vars can be set by the OS scheduler

EMAIL = os.environ.get("LOTTERY_EMAIL", "")
PASSWORD = os.environ.get("LOTTERY_PASSWORD", "")
# Set LOTTERY_HEADLESS=true in env to run without a visible browser window
HEADLESS = os.environ.get("LOTTERY_HEADLESS", "false").lower() == "true"

BASE_URL = "https://www.lottery.ie"
SCREENSHOT_DIR = Path(__file__).parent / "screenshots"
LOG_FILE = Path(__file__).parent / "lottery_agent.log"

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
        log.error("LOTTERY_EMAIL and LOTTERY_PASSWORD environment variables must be set.")
        sys.exit(1)

    SCREENSHOT_DIR.mkdir(exist_ok=True)
    log.info("=== Lottery agent starting ===")

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
            replay_last_3_tickets(page)
            log.info("=== Lottery agent finished successfully ===")
        except Exception as exc:
            screenshot(page, "fatal_error")
            log.error("Agent failed: %s", exc, exc_info=True)
            log.error("Check screenshots/ for a visual of what happened.")
            sys.exit(1)
        finally:
            context.close()
            browser.close()


# ---------------------------------------------------------------------------
# Login
# ---------------------------------------------------------------------------

def login(page):
    log.info("Opening login page...")
    page.goto(f"{BASE_URL}/account/login", wait_until="domcontentloaded", timeout=30_000)
    screenshot(page, "01_login_page")

    # Accept cookies/consent banner if present
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

    # Fill credentials
    page.fill('#username', EMAIL)
    page.fill('#password', PASSWORD)
    screenshot(page, "02_credentials_filled")

    page.click(
        'button[type="submit"], input[type="submit"], '
        'button:has-text("Log In"), button:has-text("Sign In"), '
        'button:has-text("Login"), .login-button, .btn-login'
    )
    page.wait_for_load_state("networkidle", timeout=30_000)
    screenshot(page, "03_after_login")

    current = page.url.lower()
    if "login" in current or "sign-in" in current or "signin" in current:
        raise RuntimeError(
            "Login failed — browser is still on the login page. "
            "Check your credentials or see screenshot 03_after_login."
        )
    log.info("Login succeeded. Current URL: %s", page.url)


# ---------------------------------------------------------------------------
# Ticket replay
# ---------------------------------------------------------------------------

HISTORY_URL = f"{BASE_URL}/account/tickets/draw-games"

# Selectors for individual ticket links in the history list.
TICKET_LINK_SELECTORS = [
    'a[href*="/account/tickets/"]',
    'a[href*="/ticket/"]',
    '.ticket-item a',
    '.ticket a',
    'li a[href*="ticket"]',
]

# Selectors for a confirmation / payment button after clicking "Replay same numbers".
CONFIRM_SELECTORS = [
    'button:has-text("Confirm")',
    'button:has-text("Buy Now")',
    'button:has-text("Purchase")',
    'button:has-text("Pay")',
    'button:has-text("Add to Basket")',
    'button:has-text("Continue")',
    '.confirm-btn',
    '[data-testid="confirm-btn"]',
]


def replay_last_3_tickets(page):
    log.info("Opening ticket history...")
    page.goto(HISTORY_URL, wait_until="domcontentloaded", timeout=20_000)
    page.wait_for_load_state("networkidle", timeout=15_000)
    screenshot(page, "04_ticket_history")

    # Collect the URLs of the top 3 tickets BEFORE replaying any.
    # This prevents us from replaying the same ticket three times when
    # a freshly replayed ticket jumps to the top of the list.
    ticket_urls = _collect_ticket_urls(page, count=3)

    if not ticket_urls:
        raise RuntimeError(
            "Could not find any ticket links on the history page. "
            "See screenshot 04_ticket_history."
        )

    log.info("Collected %d ticket URL(s) to replay.", len(ticket_urls))

    for i, url in enumerate(ticket_urls, 1):
        log.info("Replaying ticket %d: %s", i, url)
        page.goto(url, wait_until="domcontentloaded", timeout=20_000)
        page.wait_for_load_state("networkidle", timeout=15_000)
        screenshot(page, f"05_ticket_{i}_detail")
        _click_replay_and_confirm(page, i)


def _collect_ticket_urls(page, count: int) -> list:
    """Return the hrefs of the first `count` ticket links on the history page."""
    for sel in TICKET_LINK_SELECTORS:
        elements = page.query_selector_all(sel)
        urls = []
        seen = set()
        for el in elements:
            href = el.get_attribute("href") or ""
            if not href or href in seen:
                continue
            seen.add(href)
            urls.append(href if href.startswith("http") else f"{BASE_URL}{href}")
            if len(urls) == count:
                break
        if urls:
            log.info("Found ticket links using selector '%s'.", sel)
            return urls

    screenshot(page, "04_no_ticket_links")
    return []


def _click_replay_and_confirm(page, ticket_num: int):
    """Click 'Replay same numbers' on a ticket detail page and confirm."""
    try:
        page.click('button:has-text("Replay same numbers")', timeout=10_000)
        page.wait_for_load_state("networkidle", timeout=20_000)
        screenshot(page, f"06_ticket_{ticket_num}_after_replay")
        log.info("Clicked 'Replay same numbers' for ticket %d.", ticket_num)
    except PlaywrightTimeout:
        screenshot(page, f"06_ticket_{ticket_num}_no_replay_button")
        raise RuntimeError(
            f"'Replay same numbers' button not found for ticket {ticket_num}. "
            f"See screenshot 06_ticket_{ticket_num}_no_replay_button."
        )

    # Handle any confirmation / checkout step that follows
    for sel in CONFIRM_SELECTORS:
        try:
            page.click(sel, timeout=5_000)
            page.wait_for_load_state("networkidle", timeout=20_000)
            screenshot(page, f"07_ticket_{ticket_num}_confirmed")
            log.info("Ticket %d purchase confirmed.", ticket_num)
            return
        except PlaywrightTimeout:
            pass

    # No confirm button found — the replay may have completed automatically
    log.info(
        "No extra confirmation step found for ticket %d — assumed complete.",
        ticket_num,
    )


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def screenshot(page, name: str):
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    path = SCREENSHOT_DIR / f"{name}_{ts}.png"
    try:
        page.screenshot(path=str(path), full_page=True)
    except Exception:
        pass  # never crash just because a screenshot failed


if __name__ == "__main__":
    main()
