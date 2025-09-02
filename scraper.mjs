import { chromium } from 'playwright';

const DEFAULT_TIMEOUT = 30000;
const SHORT_TIMEOUT = 1200;
const clean = (s) => (s ?? '').replace(/\s+/g, ' ').trim() || null;

export async function getFirstOrganicListing(listUrl, logger) {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    locale: 'nl-BE',
    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();

  try {
    logger?.info({ listUrl }, 'Navigating to list URL');
    await page.goto(listUrl, { waitUntil: 'domcontentloaded', timeout: DEFAULT_TIMEOUT });

    await dismissCookies(page);

    // Wacht op 1e batch kaarten en trigger lazy content
    await page.waitForSelector('li.hz-Listing', { timeout: DEFAULT_TIMEOUT });
    await page.evaluate(() => window.scrollBy(0, 1000));
    await page.waitForTimeout(300);

    // SLEUTEL: eerste kaart MET datum EN ZONDER priority-badge
    const card = page
      .locator('li.hz-Listing:has(.hz-Listing-listingDate):not(:has(.hz-Listing-priority))')
      .first();

    // Wacht dat zo’n kaart effectief bestaat en renderbaar is
    await card.waitFor({ state: 'attached', timeout: DEFAULT_TIMEOUT });

    // helper voor optionele textcontent
    const getText = async (loc) => {
      try {
        const handle = card.locator(loc).first();
        if (await handle.count() === 0) return null;
        return clean(await handle.textContent({ timeout: SHORT_TIMEOUT }));
      } catch {
        return null;
      }
    };

    // URL
    const href =
      (await card.locator('a[href*="/v/auto-s/"]').first().getAttribute('href').catch(() => null)) ??
      (await card.locator('a[href]').first().getAttribute('href').catch(() => null));
    const pageOrigin = await page.evaluate(() => globalThis.location.origin);
    const url = href ? new URL(href, pageOrigin).href : null;

    // Titel (verplicht)
    const title =
      (await getText('[data-testid="listing-title"], h3, h2, a[title]')) ||
      (await getText('a[title]'));

    // Optioneel
    const rawPrice = await getText(
      '[data-testid="price-box-price"], .hz-Listing-price, [class*="price"]'
    );
    const date = await getText('.hz-Listing-listingDate');
    const locationText = await getText('[data-testid="location-name"], .hz-Listing-location');

    // adId
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
      title,
      price: rawPrice ? rawPrice.replace(/[^\d.,]/g, '') : null,
      location: locationText,
      date,
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
  // 1) OneTrust id
  try {
    const btn = page.locator('#onetrust-accept-btn-handler');
    if (await btn.isVisible({ timeout: 1500 })) {
      await btn.click(); return;
    }
  } catch {}
  // 2) Doorgaan zonder te accepteren
  try {
    const noBtn = page.locator('button:has-text("Doorgaan zonder te accepteren")');
    if (await noBtn.first().isVisible({ timeout: 1000 })) {
      await noBtn.first().click(); return;
    }
  } catch {}
  // 3) Accepteren
  try {
    const acc = page.locator('button:has-text("Accepteren")');
    if (await acc.first().isVisible({ timeout: 1000 })) {
      await acc.first().click(); return;
    }
  } catch {}
}
