// End-to-end check of the built site in headless Chrome: serves dist/ with `vite preview`, flips every
// scenario between Before and After (one of them with the keyboard only), switches personas, fails on any
// console error, and saves screenshots to docs/screenshots/.
//
// Usage: npm run build && npm run e2e      (set CHROME_PATH if Chrome isn't at /usr/bin/google-chrome)

import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { preview } from "vite";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHOTS = path.join(ROOT, "docs", "screenshots");
const CHROME = process.env.CHROME_PATH ?? "/usr/bin/google-chrome";

const EXPECTED = {
  "read-notes": { before: "Bug reproduced", after: "Fixed" },
  "write-notes": { before: "Bug reproduced", after: "Fixed" },
  paywall: { before: "Bug reproduced", after: "Fixed" },
  webhook: { before: "Bug reproduced", after: "Fixed" },
};

const card = (id) => `[data-scenario="${id}"]`;

/** Waits until no scenario is running and returns each one's status line. */
async function settled(page) {
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll(".scenario")].every(
        (el) => !el.hasAttribute("aria-busy") && el.querySelector(".run-status .badge"),
      ),
    null,
    { timeout: 60_000 },
  );
  return page.$$eval(".scenario", (els) =>
    Object.fromEntries(els.map((el) => [el.dataset.scenario, el.querySelector(".run-status").textContent])),
  );
}

async function stepTexts(page, id) {
  return page.$$eval(`${card(id)} .step .finding`, (els) => els.map((el) => el.textContent));
}

async function shot(page, id, name) {
  await page.evaluate((selector) => {
    const el = document.querySelector(selector);
    window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 70);
  }, card(id));
  await page.screenshot({ path: path.join(SHOTS, name) });
}

async function main() {
  mkdirSync(SHOTS, { recursive: true });
  const server = await preview({ root: ROOT, logLevel: "silent", preview: { port: 0, host: "127.0.0.1" } });
  const url = server.resolvedUrls.local[0];
  const browser = await chromium.launch({ executablePath: CHROME });
  const errors = [];

  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, colorScheme: "light" });
    page.on("console", (msg) => msg.type() === "error" && errors.push(msg.text()));
    page.on("pageerror", (error) => errors.push(String(error)));

    await page.goto(url);
    let status = await settled(page);
    for (const [id, expected] of Object.entries(EXPECTED)) {
      assert.match(status[id], new RegExp(`^${expected.before} v0-broken`), `${id} before: ${status[id]}`);
    }
    assert.match((await stepTexts(page, "read-notes"))[0], /Bob reads 1 note owned by someone else/);
    console.log("✓ all four scenarios reproduce the bug on v0-broken (as Bob)");
    await page.screenshot({ path: path.join(SHOTS, "01-overview.png") });
    await shot(page, "read-notes", "02-read-notes-before.png");
    await shot(page, "webhook", "06-webhook-before.png");

    // Keyboard only: Tab to the first scenario's toggle, then arrow to "After".
    await page.focus(`${card("read-notes")} input[value="before"]`);
    await page.keyboard.press("ArrowRight");
    status = await settled(page);
    assert.match(status["read-notes"], /^Fixed main/, `keyboard toggle: ${status["read-notes"]}`);
    console.log("✓ the keyboard flips a scenario to main");

    for (const id of ["write-notes", "paywall", "webhook"]) {
      await page.locator(`${card(id)} input[value="after"]`).check();
    }
    status = await settled(page);
    for (const [id, expected] of Object.entries(EXPECTED)) {
      assert.match(status[id], new RegExp(`^${expected.after} main`), `${id} after: ${status[id]}`);
    }
    assert.match((await stepTexts(page, "write-notes"))[0], /row-level security policy/);
    assert.match((await stepTexts(page, "paywall"))[3], /plan = free/);
    assert.match((await stepTexts(page, "webhook"))[3], /plan = pro/);
    console.log("✓ all four are blocked on main");
    await shot(page, "read-notes", "03-read-notes-after.png");
    await shot(page, "write-notes", "04-write-notes-after.png");
    await shot(page, "paywall", "05-paywall-after.png");
    await shot(page, "webhook", "07-webhook-after.png");

    await page.locator('input[name="persona"][value="anon"]').check();
    await page.locator(`${card("read-notes")} input[value="before"]`).check();
    status = await settled(page);
    assert.match((await stepTexts(page, "read-notes"))[0], /An anonymous visitor reads 1 note/);
    assert.match(await page.textContent(`${card("paywall")} .persona-note`), /Runs as Bob/);
    console.log("✓ the persona switch re-runs the scenarios as anon");

    const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, colorScheme: "dark" });
    mobile.on("console", (msg) => msg.type() === "error" && errors.push(msg.text()));
    await mobile.goto(url);
    await settled(mobile);
    assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
    await mobile.screenshot({ path: path.join(SHOTS, "08-mobile-dark.png") });
    console.log("✓ mobile, dark scheme: no horizontal overflow");

    assert.deepEqual(errors, [], "console errors");
    console.log(`✓ no console errors. Screenshots in ${path.relative(ROOT, SHOTS)}/`);
  } finally {
    await browser.close();
    await new Promise((resolve) => server.httpServer.close(resolve));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
