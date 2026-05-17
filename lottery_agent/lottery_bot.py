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
        'button:has-text("Allow All")',
        'button:has-text("Allow all")',
        'button:has-text("Accept All")',
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
    page.fill('input[type="email"], input[name="email"], input[name="username"]', EMAIL)
    page.fill('input[type="password"], input[name="password"]', PASSWORD)
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

# Ordered list of paths lottery.ie uses for ticket/order history.
HISTORY_PATHS = [
    "/my-account/my-tickets",
    "/my-account/tickets",
    "/my-account/orders",
    "/account/my-tickets",
    "/account/tickets",
    "/my-tickets",
]

# Selectors that might identify a "Play Again" / "Replay" action.
REPLAY_SELECTORS = [
    'button:has-text("Play Again")',
    'a:has-text("Play Again")',
    'button:has-text("Replay")',
    'a:has-text("Replay")',
    'button:has-text("Re-enter")',
    'a:has-text("Re-enter")',
    '.play-again',
    '.replay-btn',
    '[data-testid="replay-btn"]',
    '[data-action="replay"]',
]

# Selectors for a confirmation / payment button after clicking replay.
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
    log.info("Looking for ticket history...")
    reached = False
    for path in HISTORY_PATHS:
        page.goto(f"{BASE_URL}{path}", wait_until="domcontentloaded", timeout=20_000)
        url = page.url.lower()
        if "404" not in url and "not-found" not in url and "error" not in url:
            reached = True
            log.info("Ticket history page: %s", page.url)
            break

    if not reached:
        screenshot(page, "04_history_not_found")
        raise RuntimeError("Could not reach the ticket history page. See screenshot 04_history_not_found.")

    page.wait_for_load_state("networkidle", timeout=15_000)
    screenshot(page, "04_ticket_history")

    # Collect up to 3 replay buttons
    replay_buttons = []
    for sel in REPLAY_SELECTORS:
        buttons = page.query_selector_all(sel)
        if buttons:
            log.info("Found %d replay element(s) with selector '%s'.", len(buttons), sel)
            replay_buttons = buttons
            break

    if not replay_buttons:
        screenshot(page, "04_no_replay_buttons")
        raise RuntimeError(
            "No 'Play Again' / 'Replay' buttons found. "
            "The site layout may have changed — see screenshot 04_no_replay_buttons."
        )

    replayed = 0
    for btn in replay_buttons[:3]:
        _replay_single(page, btn, replayed + 1)
        replayed += 1
        # Return to history page for next ticket
        if replayed < 3 and len(replay_buttons) > replayed:
            page.go_back()
            page.wait_for_load_state("networkidle", timeout=15_000)

    log.info("Replayed %d ticket(s).", replayed)


def _replay_single(page, button, ticket_num: int):
    log.info("Replaying ticket %d...", ticket_num)
    button.click()
    page.wait_for_load_state("networkidle", timeout=20_000)
    screenshot(page, f"05_replay_{ticket_num}_after_click")

    # Look for a confirmation button in the resulting page/modal
    confirmed = False
    for sel in CONFIRM_SELECTORS:
        try:
            page.click(sel, timeout=5_000)
            page.wait_for_load_state("networkidle", timeout=20_000)
            screenshot(page, f"06_replay_{ticket_num}_confirmed")
            log.info("Ticket %d confirmed.", ticket_num)
            confirmed = True
            break
        except PlaywrightTimeout:
            pass

    if not confirmed:
        log.warning(
            "No confirmation button found for ticket %d — the page may have "
            "already handled it automatically. See screenshot 05_replay_%d_after_click.",
            ticket_num, ticket_num,
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
