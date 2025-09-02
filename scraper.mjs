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

    // Let the page settle so priority badges can render
    await page.waitForSelector('li.hz-Listing', { timeout: DEFAULT_TIMEOUT });
    await page.waitForLoadState('networkidle', { timeout: DEFAULT_TIMEOUT }).catch(() => {});
    await page.evaluate(() => window.scrollBy(0, 1200));
    await page.waitForTimeout(350);

    // Candidates = only cards that HAVE a date (normal listing trait)
    const candidates = page.locator('li.hz-Listing:has(.hz-Listing-listingDate)');
    const total = await candidates.count();

    for (let i = 0; i < Math.min(total, 25); i++) {
      const card = candidates.nth(i);

      // Re-check after a small settle to catch late-added badges
      await card.waitFor({ state: 'attached', timeout: DEFAULT_TIMEOUT });
      await page.waitForTimeout(120);

      const hasPriority = (await card.locator('.hz-Listing-priority').count()) > 0;

      // Text fallback (sometimes only text is present)
      let txt = '';
      try {
        txt = ((await card.textContent({ timeout: SHORT_TIMEOUT })) || '').toLowerCase();
      } catch {}

      const looksSponsored =
        hasPriority ||
        txt.includes('topadvertentie') ||
        txt.includes('topzoekertje') ||
        txt.includes('gesponsord') ||
        /\badvertentie\b/.test(txt);

      if (looksSponsored) continue; // skip Iveco-like topadvertenties

      // --- extract fields (url & title required, rest optional) ---
      const href =
        (await card.locator('a[href*="/v/auto-s/"]').first().getAttribute('href').catch(() => null)) ??
        (await card.locator('a[href]').first().getAttribute('href').catch(() => null));

      const pageOrigin = await page.evaluate(() => globalThis.location.origin);
      const url = href ? new URL(href, pageOrigin).href : null;

      const title =
        (await getText(card, '[data-testid="listing-title"], h3, h2, a[title]')) ||
        (await getText(card, 'a[title]'));

      const rawPrice = await getText(
        card,
        '[data-testid="price-box-price"], .hz-Listing-price, [class*="price"]'
      );
      const date = await getText(card, '.hz-Listing-listingDate');
      const locationText = await getText(card, '[data-testid="location-name"], .hz-Listing-location');

      // adId from URL
      let adId = null;
      if (url) {
        const m = url.match(/m(\d+)-/);
        if (m) adId = m[1];
        const m2 = url.match(/\/(\d{9,})/);
        if (!adId && m2) adId = m2[1];
      }

      if (!url || !title) continue; // if this card is incomplete, try next

      return {
        url,
        title: clean(title),
        price: rawPrice ? clean(rawPrice.replace(/[^\d.,]/g, '')) : null,
        location: clean(locationText),
        date: clean(date),
        adId,
        scrapedAt: new Date().toISOString(),
        listUrlUsed: listUrl
      };
    }

    throw new Error('Geen normale (niet-gesponsorde) kaart met datum gevonden binnen de eerste 25 kaarten.');
  } finally {
    await context.close();
    await browser.close();
  }
}

// safe text getter (returns null if missing/slow)
async function getText(card, selector) {
  try {
    const loc = card.locator(selector).first();
    if ((await loc.count()) === 0) return null;
    const txt = await loc.textContent({ timeout: SHORT_TIMEOUT });
    return txt ? txt.trim() : null;
  } catch {
    return null;
  }
}

async function dismissCookies(page) {
  try {
    const btn = page.locator('#onetrust-accept-btn-handler');
    if (await btn.isVisible({ timeout: 1500 })) { await btn.click(); return; }
  } catch {}

  try {
    const noBtn = page.locator('button:has-text("Doorgaan zonder te accepteren")');
    if (await noBtn.first().isVisible({ timeout: 1000 })) { await noBtn.first().click(); return; }
  } catch {}

  try {
    const acc = page.locator('button:has-text("Accepteren")');
    if (await acc.first().isVisible({ timeout: 1000 })) { await acc.first().click(); return; }
  } catch {}
}
