import { chromium } from 'playwright';

const DEFAULT_TIMEOUT = 25000;
const clean = (s) => (s ?? '').replace(/\s+/g, ' ').trim() || null;

export async function getFirstOrganicListing(listUrl, logger) {
  const browser = await chromium.launch(); // headless in Playwright base image
  const context = await browser.newContext({
    locale: 'nl-BE',
    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();

  try {
    logger?.info({ listUrl }, 'Navigating to list URL');
    await page.goto(listUrl, { waitUntil: 'domcontentloaded', timeout: DEFAULT_TIMEOUT });

    // Cookie banner wegklikken
    await dismissCookies(page);

    // Zorg dat er listings zijn
    await page.waitForSelector('li.hz-Listing', { timeout: DEFAULT_TIMEOUT });

    // Scroll klein stukje voor lazy content
    await page.evaluate(() => window.scrollBy(0, 800));
    await page.waitForTimeout(300);

    // >>> SLEUTEL: eerste kaart MET datum EN ZONDER priority-badge
    const card = page
      .locator('li.hz-Listing:has(.hz-Listing-listingDate):not(:has(.hz-Listing-priority))')
      .first();

    // Wacht tot zo'n kaart effectief bestaat, anders error
    await card.waitFor({ state: 'attached', timeout: DEFAULT_TIMEOUT });

    // Extract met locators (geen $$eval/loops meer)
    const href =
      (await card.locator('a[href*="/v/auto-s/"]').first().getAttribute('href')) ??
      (await card.locator('a[href]').first().getAttribute('href'));
    const pageOrigin = await page.evaluate(() => globalThis.location.origin);
    const url = href ? new URL(href, pageOrigin).href : null;

    const title =
      (await card
        .locator('[data-testid="listing-title"], h3, h2, a[title]')
        .first()
        .textContent()) || null;

    const rawPrice =
      (await card
        .locator('[data-testid="price-box-price"], .hz-Listing-price, [class*="price"]')
        .first()
        .textContent()) || null;

    const date =
      (await card.locator('.hz-Listing-listingDate').first().textContent()) || null;

    const locText =
      (await card
        .locator('[data-testid="location-name"], .hz-Listing-location')
        .first()
        .textContent()) || null;

    // adId uit URL
    let adId = null;
    if (url) {
      const m = url.match(/m(\d+)-/);
      if (m) adId = m[1];
      const m2 = url.match(/\/(\d{9,})/);
      if (!adId && m2) adId = m2[1];
    }

    if (!url || !title) throw new Error('Kaart onvolledig (geen url of titel).');

    return {
      url,
      title: clean(title),
      price: clean(rawPrice ? rawPrice.replace(/[^\d.,]/g, '') : null),
      location: clean(locText),
      date: clean(date),
      adId,
      scrapedAt: new Date().toISOString(),
      listUrlUsed: listUrl
    };
  } finally {
    await context.close();
    await browser.close();
  }
}

async function dismissCookies(page) {
  // 1) standaard OneTrust id
  try {
    const btn = page.locator('#onetrust-accept-btn-handler');
    if (await btn.isVisible({ timeout: 2000 })) {
      await btn.click();
      return;
    }
  } catch {}
  // 2) “Doorgaan zonder te accepteren”
  try {
    const noBtn = page.locator('button:has-text("Doorgaan zonder te accepteren")');
    if (await noBtn.first().isVisible({ timeout: 1500 })) {
      await noBtn.first().click();
      return;
    }
  } catch {}
  // 3) “Accepteren”
  try {
    const acc = page.locator('button:has-text("Accepteren")');
    if (await acc.first().isVisible({ timeout: 1500 })) {
      await acc.first().click();
      return;
    }
  } catch {}
}
