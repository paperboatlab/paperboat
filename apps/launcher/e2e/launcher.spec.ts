import { expect, test } from "@playwright/test";

test("Launcher UX: dynamic section-specific menus & top bar, theme controller, gliding animations, Apps feedback, Stations, and Toolkit block cards", async ({ page }) => {
  await page.setViewportSize({ width: 1240, height: 800 });
  await page.goto("/");

  const topBar = page.locator("header.bar");
  const menubar = topBar.locator(".menubar");

  // 1. APPS SECTION: Dynamic menus ("Apps", "View", "Channel (...)", "Sessions (...)"), clean header & 3 App Cards
  const appsPanel = page.locator("section.panel[aria-label='Apps']");
  await expect(appsPanel).toHaveClass(/current/);
  await expect(menubar.getByRole("menuitem", { name: "Apps" })).toBeVisible();
  await expect(menubar.getByRole("menuitem", { name: /Channel/ })).toBeVisible();
  await expect(menubar.getByRole("menuitem", { name: /Sessions/ })).toBeVisible();

  // Open the "Apps" menu dropdown and verify items
  await menubar.getByRole("menuitem", { name: "Apps" }).click();
  await expect(topBar.locator(".menu[aria-label='File']")).toContainText("Check for updates");
  await page.keyboard.press("Escape");

  const appCards = appsPanel.locator(".app-card");
  await expect(appCards).toHaveCount(3);
  await expect(appsPanel.locator(".rm-x")).toHaveCount(0);

  // 2. Theme controller matches Paperboat apps (ThemeToggle cycling auto -> light -> dark)
  const themeBtn = topBar.locator(".bar-end button.icon-key[aria-label^='Theme:']");
  await expect(themeBtn).toHaveAttribute("aria-label", "Theme: auto");
  await themeBtn.click();
  await expect(themeBtn).toHaveAttribute("aria-label", "Theme: light");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

  // 3. Check for updates button in top bar triggers inline feedback banner on the Paperboat card
  await topBar.getByRole("button", { name: "Check for updates" }).click();
  const feedback = appsPanel.locator(".inline-feedback").first();
  await expect(feedback).toBeVisible();
  await page.screenshot({ path: "/tmp/launcher-apps-light.png" });

  await themeBtn.click();
  await expect(themeBtn).toHaveAttribute("aria-label", "Theme: dark");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

  // 4. STATIONS SECTION: Dynamic menus ("Station", "Build & Check", "Run (...)"), Source switch in top bar
  await page.locator(".rail .rail-item", { hasText: "stations" }).click();
  const stationsPanel = page.locator("section.panel[aria-label='Stations']");
  await expect(stationsPanel).toHaveClass(/current/);
  await page.waitForTimeout(320);

  await expect(menubar.getByRole("menuitem", { name: "Station" })).toBeVisible();
  await expect(menubar.getByRole("menuitem", { name: "Build" })).toBeVisible();
  await expect(menubar.getByRole("menuitem", { name: "Run" })).toBeVisible();
  await expect(topBar.locator(".bar-end").getByRole("button", { name: "Open .pst…" })).toBeVisible();
  await expect(topBar.locator(".bar-end .switch[aria-label='Source']")).toBeVisible();

  // Open the "Build" dropdown menu
  await menubar.getByRole("menuitem", { name: "Build" }).click();
  await expect(topBar.locator(".menu")).toContainText("Run 4-stage verification (check)");
  await page.keyboard.press("Escape");

  await stationsPanel.getByRole("button", { name: /Options/ }).click();
  await expect(stationsPanel.locator(".be-run-drawer")).toBeVisible();
  await page.screenshot({ path: "/tmp/launcher-stations-dark.png" });

  // Switch back to light for Toolkits screenshot
  await themeBtn.click(); // auto
  await themeBtn.click(); // light

  // 5. TOOLKITS SECTION: Dynamic menus ("Toolkit (control)", "Blocks (...)"), Kind switch in top bar, Block Cards
  await page.locator(".rail .rail-item", { hasText: "toolkits" }).click();
  const toolkitsPanel = page.locator("section.panel[aria-label='Toolkits']");
  await expect(toolkitsPanel).toHaveClass(/current/);
  await page.waitForTimeout(320);

  await expect(menubar.getByRole("menuitem", { name: "Toolkit" })).toBeVisible();
  await expect(menubar.getByRole("menuitem", { name: "Blocks" })).toBeVisible();
  await expect(topBar.locator(".bar-end .switch[aria-label='Kind']")).toBeVisible();

  const blockCards = toolkitsPanel.locator(".block-cards-grid .block-card");
  await expect(blockCards.first()).toBeVisible();
  await page.screenshot({ path: "/tmp/launcher-toolkits-light.png" });

  const pidCard = blockCards.filter({ hasText: "control/pid" });
  await expect(pidCard.locator(".block-card-head b")).toHaveText("PID");
  await expect(pidCard.locator(".block-card-desc")).not.toBeEmpty();

  // 6. CONSOLE SECTION: Dynamic menus ("CLI Commands", "Console"), Help & Clear keys in top bar
  await page.locator(".rail .rail-item", { hasText: "paperboat cli" }).click();
  const consolePanel = page.locator("section.panel[aria-label='Paperboat CLI']");
  await expect(consolePanel).toHaveClass(/current/);
  await expect(menubar.getByRole("menuitem", { name: "CLI Commands" })).toBeVisible();
  await expect(menubar.getByRole("menuitem", { name: "Console" })).toBeVisible();
  await expect(topBar.locator(".bar-end").getByRole("button", { name: "Help" })).toBeVisible();
  await expect(topBar.locator(".bar-end").getByRole("button", { name: "Clear" })).toBeVisible();
});
