import { test, expect, beforeAll, afterAll } from "bun:test";
import { chromium } from "../.runtime/web/node_modules/playwright-core/index.mjs";
import { ensureUnpersonalized } from "./privacy";

const chrome = process.env.CODEX_WEB_TEST_CHROME;
let browser: any;
beforeAll(async () => { if (chrome) browser = await chromium.launch({ executablePath: chrome, headless: true }); });
afterAll(async () => { await browser?.close(); });
async function fixture(notice: string, duplicate = false, noticeDelay = 0) {
  const page = await browser.newPage();
  await page.route("**/*", (route: any) => route.fulfill({ contentType: "text/html; charset=utf-8", body: `<!doctype html><meta charset="utf-8">
    <button id="policy" aria-label="Personalized" aria-controls="owned" onclick="document.querySelector('#owned').hidden=false">Personalized</button>
    <div id="owned" role="menu" hidden>
      <button role="menuitemradio" onclick="const p=document.querySelector('#policy');p.textContent='Unpersonalized';p.setAttribute('aria-label','Unpersonalized');document.querySelector('#owned').hidden=true">Unpersonalized</button>
      ${duplicate ? '<button role="radio">Unpersonalized duplicate</button>' : ''}
    </div>
    <button role="radio" onclick="window.unrelatedClicked=true">Unpersonalized unrelated control</button>
    <dialog><h2>Temporary chat</h2><p>${notice}</p><button onclick="window.noticeAccepted=true;document.querySelector('dialog').close()">Continue</button></dialog>
    <script>setTimeout(() => document.querySelector('dialog').showModal(), ${noticeDelay})</script>` }));
  await page.goto("https://chatgpt.com/?temporary-chat=true");
  return page;
}
test.skipIf(!chrome)("native Temporary Chat notice is dismissed before selecting only its owned privacy option", async () => {
  const page = await fixture("This chat won’t appear in history. You can choose whether to personalize replies.");
  try {
    await ensureUnpersonalized(page, { noticeWaitMs: 0 });
    expect(await page.getByRole("button", { name: "Unpersonalized", exact: true }).isVisible()).toBe(true);
    expect(await page.evaluate(() => (window as any).noticeAccepted)).toBe(true);
    expect(await page.evaluate(() => (window as any).unrelatedClicked)).toBeUndefined();
  } finally { await page.close(); }
}, 10000);
test.skipIf(!chrome)("late notice hydration is handled even when the privacy label already exists", async () => {
  const page = await fixture("This chat won’t appear in history.", false, 200);
  try {
    await ensureUnpersonalized(page, { noticeWaitMs: 1500 });
    expect(await page.evaluate(() => (window as any).noticeAccepted)).toBe(true);
    expect(await page.getByRole("button", { name: "Unpersonalized", exact: true }).isVisible()).toBe(true);
  } finally { await page.close(); }
}, 10000);
test.skipIf(!chrome)("unknown dialogs are never accepted as Temporary Chat notices", async () => {
  const page = await fixture("Authorize a purchase or change your account settings.");
  try {
    await expect(ensureUnpersonalized(page, { noticeWaitMs: 0 })).rejects.toThrow();
    expect(await page.evaluate(() => (window as any).noticeAccepted)).toBeUndefined();
  } finally { await page.close(); }
}, 10000);
test.skipIf(!chrome)("ambiguous privacy choices fail without touching an unrelated menu", async () => {
  const page = await fixture("This chat won’t appear in history.", true);
  try {
    await page.locator("dialog").evaluate((dialog: any) => dialog.close());
    await expect(ensureUnpersonalized(page, { noticeWaitMs: 0 })).rejects.toThrow("temporary_chat_privacy_unverified");
    expect(await page.evaluate(() => (window as any).unrelatedClicked)).toBeUndefined();
  } finally { await page.close(); }
}, 12000);
