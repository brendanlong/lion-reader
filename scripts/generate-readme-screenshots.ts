/**
 * Regenerate the README screenshots (docs/screenshots/*.png) from the
 * interactive demo, so they show the real UI and can be refreshed when it
 * changes.
 *
 * The default base URL is production, so the shots show what's deployed. To
 * capture a branch, run `pnpm dev:local` and pass its URL.
 *
 * Usage: pnpm readme-screenshots [base-url]   (default https://lionreader.com)
 */
import { chromium, type Browser, type BrowserContextOptions, type Page } from "@playwright/test";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { THEME_STORAGE_KEY, type THEMES } from "../src/lib/theme/config";

type Theme = (typeof THEMES)[number];

const baseUrl = process.argv[2] ?? "https://lionreader.com";
const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "docs", "screenshots");

const DESKTOP = { width: 1280, height: 800 };
const PHONE = { width: 390, height: 844 };
const PHONE_GAP = 40;

async function openDemo(
  browser: Browser,
  theme: Theme,
  entry: string | null,
  options: BrowserContextOptions
): Promise<Page> {
  const context = await browser.newContext({ deviceScaleFactor: 2, ...options });
  await context.addInitScript(([key, value]) => localStorage.setItem(key, value), [
    THEME_STORAGE_KEY,
    theme,
  ] as const);
  const page = await context.newPage();
  const query = entry ? `?entry=${entry}` : "";
  await page.goto(`${baseUrl}/demo/all${query}`, { waitUntil: "networkidle" });
  return page;
}

async function clickButton(page: Page, text: string): Promise<void> {
  await page.locator("button:visible", { hasText: text }).first().click();
}

async function save(page: Page, file: string): Promise<void> {
  const outputPath = path.join(outDir, file);
  await page.screenshot({ path: outputPath, animations: "disabled" });
  console.log(`Wrote ${outputPath}`);
}

async function main() {
  const browser = await chromium.launch();
  try {
    const desktop = { viewport: DESKTOP };
    const phone = { viewport: PHONE, isMobile: true, hasTouch: true };

    const list = await openDemo(browser, "light", null, desktop);
    await save(list, "list.png");

    const summary = await openDemo(browser, "light", "plugins", desktop);
    await clickButton(summary, "Summarize");
    await summary.locator("button:visible", { hasText: "Hide Summary" }).waitFor();
    await save(summary, "summary.png");

    const narration = await openDemo(browser, "dark", "text-to-speech", desktop);
    await clickButton(narration, "Listen");
    await narration.locator("button:visible", { hasText: "Pause" }).waitFor();
    await save(narration, "narration.png");

    const phoneList = await openDemo(browser, "dark", null, phone);
    const phoneArticle = await openDemo(browser, "epaper", "email-newsletters", phone);
    const shots = await Promise.all(
      [phoneList, phoneArticle].map((page) => page.screenshot({ animations: "disabled" }))
    );

    // Lay the two phone shots side by side on a transparent background.
    const composite = await browser.newPage({
      viewport: { width: PHONE.width * 2 + PHONE_GAP, height: PHONE.height },
      deviceScaleFactor: 2,
    });
    const images = shots
      .map(
        (png) =>
          `<img src="data:image/png;base64,${png.toString("base64")}" width="${PHONE.width}" height="${PHONE.height}">`
      )
      .join("");
    await composite.setContent(
      `<body style="margin:0;display:flex;gap:${PHONE_GAP}px;background:transparent">${images}</body>`
    );
    await composite.screenshot({ path: path.join(outDir, "mobile.png"), omitBackground: true });
    console.log(`Wrote ${path.join(outDir, "mobile.png")}`);
  } finally {
    await browser.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
