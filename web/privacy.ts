/** Require a verified non-personalized Temporary Chat; never save or edit global settings. */
export async function ensureUnpersonalized(page: any): Promise<void> {
  const url = new URL(page.url());
  if (url.origin !== "https://chatgpt.com" || url.pathname !== "/" || url.searchParams.get("temporary-chat") !== "true")
    throw new Error("temporary_chat_required");
  const off = page.getByRole("button", { name: /^(Unpersonalized|非个性化)$/, exact: true, includeHidden: true }).filter({ visible: true });
  if (await off.isVisible().catch(() => false)) return;
  const on = page.getByRole("button", { name: /^(Personalized|个性化)$/, exact: true, includeHidden: true }).filter({ visible: true });
  if (!await on.isVisible().catch(() => false)) throw new Error("temporary_chat_privacy_unverified");
  await on.click({ timeout: 5000 });
  const menuId = await on.getAttribute("aria-controls");
  if (!menuId) throw new Error("temporary_chat_privacy_unverified");
  const menu = page.locator(`[id=${JSON.stringify(menuId)}]`);
  const choice = menu.getByRole("menuitemradio", { name: /^(Unpersonalized|非个性化)/ });
  const radio = menu.getByRole("radio", { name: /^(Unpersonalized|非个性化)/ });
  await choice.or(radio).first().click({ timeout: 5000 });
  await off.waitFor({ state: "visible", timeout: 5000 });
}
