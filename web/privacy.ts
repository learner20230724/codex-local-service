/** Require a verified non-personalized Temporary Chat; never save or edit global settings. */
const observedPages = new WeakSet<object>();
function observePageFailures(page: any) {
  if (typeof page.on !== "function" || observedPages.has(page)) return;
  observedPages.add(page);
  page.on("response", (response: any) => {
    const url = new URL(response.url());
    if (url.origin !== "https://chatgpt.com" || !url.pathname.startsWith("/backend-api/") || response.status() < 400) return;
    const category = url.pathname.includes("conversation") ? "conversation" : url.pathname.includes("accounts") ? "account" : "backend";
    const headers = response.headers();
    console.warn(JSON.stringify({ event: "codex_web.http_failure", category, status: response.status(),
      content_type: headers["content-type"], challenge: headers["cf-mitigated"] === "challenge" }));
  });
  page.on("request", (request: any) => {
    const url = new URL(request.url());
    if (url.origin !== "https://chatgpt.com" || !/^\/backend-api\/(f\/)?conversation$/.test(url.pathname) || request.method() !== "POST") return;
    try {
      const body = request.postDataJSON();
      console.info(JSON.stringify({ event: "codex_web.privacy_request",
        temporary: typeof body.is_temporary === "boolean" ? body.is_temporary : null,
        history_disabled: typeof body.history_and_training_disabled === "boolean" ? body.history_and_training_disabled : null }));
    } catch { /* Diagnostics never change request behavior; no body, headers or identities are logged. */ }
  });
}
async function dismissTemporaryChatNotice(page: any, waitMs = 0): Promise<boolean> {
  const dialog = page.locator('dialog[open],[role="dialog"]').filter({
    hasText: /This chat won.t appear in history|此聊天不会出现在历史记录|此对话不会显示在历史记录/,
  }).filter({ visible: true });
  if (waitMs > 0) await dialog.waitFor({ state: "visible", timeout: waitMs }).catch(() => {});
  if (await dialog.count() !== 1) return false;
  const proceed = dialog.getByRole("button", { name: /^(Continue|继续)$/, exact: true });
  if (await proceed.count() !== 1) return false;
  await proceed.press("Enter", { timeout: 5000 });
  await dialog.waitFor({ state: "hidden", timeout: 5000 });
  return true;
}
export async function ensureUnpersonalized(page: any, options: { noticeWaitMs?: number } = {}): Promise<void> {
  const url = new URL(page.url());
  if (url.origin !== "https://chatgpt.com" || url.pathname !== "/" || url.searchParams.get("temporary-chat") !== "true")
    throw new Error("temporary_chat_required");
  observePageFailures(page);
  // ChatGPT hydrates this notice after rendering the composer and privacy label.
  await dismissTemporaryChatNotice(page, options.noticeWaitMs ?? 5000);
  const off = page.getByRole("button", { name: /^(Unpersonalized|非个性化)$/, exact: true, includeHidden: true }).filter({ visible: true });
  if (await off.isVisible().catch(() => false)) return;
  const on = page.getByRole("button", { name: /^(Personalized|个性化)$/, exact: true, includeHidden: true }).filter({ visible: true });
  if (!await on.isVisible().catch(() => false)) throw new Error("temporary_chat_privacy_unverified");
  try { await on.click({ timeout: 5000 }); }
  catch (error) {
    // The notice can hydrate after the composer and intercept the first click.
    if (!await dismissTemporaryChatNotice(page)) throw error;
    await on.click({ timeout: 5000 });
  }
  const menuId = await on.getAttribute("aria-controls");
  if (!menuId) throw new Error("temporary_chat_privacy_unverified");
  const menu = page.locator(`[id=${JSON.stringify(menuId)}]`);
  await menu.waitFor({ state: "visible", timeout: 5000 });
  const choice = menu.locator('[role="menuitemradio"],[role="radio"]').filter({ hasText: /^(Unpersonalized|非个性化)/ });
  if (await choice.count() !== 1) throw new Error("temporary_chat_privacy_unverified");
  await choice.click({ timeout: 5000 });
  await off.waitFor({ state: "visible", timeout: 5000 });
  await on.waitFor({ state: "hidden", timeout: 5000 });
  await page.keyboard.press("Escape");
  await menu.waitFor({ state: "hidden", timeout: 5000 });
}
