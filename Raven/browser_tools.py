from __future__ import annotations

from pathlib import Path


class BrowserTools:
    def __init__(self, headless: bool = True, user_data_dir: str | None = None):
        self.headless = headless
        self.user_data_dir = str(Path(user_data_dir).expanduser()) if user_data_dir else None

    def browser_fetch(self, url: str) -> dict:
        try:
            from playwright.sync_api import sync_playwright
        except ImportError:
            return {"error": "playwright not installed. `pip install playwright && playwright install chromium`."}

        try:
            with sync_playwright() as p:
                if self.user_data_dir:
                    Path(self.user_data_dir).mkdir(parents=True, exist_ok=True)
                    context = p.chromium.launch_persistent_context(self.user_data_dir, headless=self.headless)
                    page = context.new_page()
                else:
                    browser = p.chromium.launch(headless=self.headless)
                    context = browser.new_context()
                    page = context.new_page()

                page.goto(url, timeout=30000, wait_until="networkidle")
                title = page.title()
                content = page.inner_text("body")

                if self.user_data_dir:
                    context.close()
                else:
                    browser.close()

            return {"url": url, "title": title, "content": content[:8000]}
        except Exception as e:
            return {"error": str(e)}
