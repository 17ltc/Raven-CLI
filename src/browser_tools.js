'use strict';
/**
 * Real-browser page fetch. Port of Raven/browser_tools.py
 *
 * Playwright is an optional dependency: install with
 *   npm install playwright && npx playwright install chromium
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

class BrowserTools {
  constructor(headless = true, userDataDir = null) {
    this.headless = headless;
    this.userDataDir = userDataDir ? path.resolve(userDataDir.replace(/^~/, os.homedir())) : null;
  }

  async browserFetch(url) {
    let parsed;
    try { parsed = new URL(String(url)); } catch (e) { return { error: 'Only valid http(s) URLs are allowed.' }; }
    if (!['http:', 'https:'].includes(parsed.protocol)) return { error: 'Only http(s) URLs are allowed.' };
    let playwright;
    try {
      playwright = require('playwright');
    } catch (e) {
      return { error: 'playwright not installed. `npm install playwright && npx playwright install chromium`.' };
    }

    let browser = null;
    let context = null;
    try {
      let page;
      if (this.userDataDir) {
        fs.mkdirSync(this.userDataDir, { recursive: true });
        context = await playwright.chromium.launchPersistentContext(this.userDataDir, { headless: this.headless });
        page = await context.newPage();
      } else {
        browser = await playwright.chromium.launch({ headless: this.headless });
        context = await browser.newContext();
        page = await context.newPage();
      }

      await page.goto(parsed.href, { timeout: 30000, waitUntil: 'domcontentloaded' });
      const title = await page.title();
      const content = await page.innerText('body');

      return { url, title, content: content.slice(0, 8000) };
    } catch (e) {
      return { error: e.message };
    } finally {
      try {
        if (this.userDataDir && context) await context.close();
        else if (browser) await browser.close();
      } catch (e) {
        /* ignore cleanup errors */
      }
    }
  }
}

module.exports = { BrowserTools };
