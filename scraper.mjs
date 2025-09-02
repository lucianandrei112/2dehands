import { chromium } from 'playwright';

const DEFAULT_TIMEOUT = 25000;
const clean = (s) => (s ?? '').replace(/\s+/g, ' ').trim() || null;

export async function getFirstOrganicListing(listUrl, logger) {
  const browser = await chromium.launch(); // headless via Playwright base image
  const context = await browser.newContext({
    locale: 'nl-BE',
    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();

  try {
    logger?.info({ listUrl }, 'Navigating to list URL');
    await page.goto(listUrl, { waitUntil: 'domcontentloaded', timeout: DEFAULT_TIMEOUT });

    // Cookiebanner wegklikken (OneTrust)
    await dismissCookies(page);

    // Wacht tot er kaarten zijn
    await page.waitForSelector('li.hz-Listing', { timeout: DEFAULT_TIMEOUT });

    // Klein scrolltje om lazy content te triggeren
    await page.evaluate(() => window.scrollBy(0, 800));
    await page.waitForTimeout(400);

    // >>> Belangrijk: alleen kaarten met .hz-Listing-listingDate tellen mee <<<
    const result = await page.$$eval('li.hz-Listing', (cards) => {
      const extract = (card) => {
        const pageOrigin =
          (globalThis && globalThis.location && globalThis.location.origin) ||
          (document && document.location && document.location.origin) ||
          '';

        // Link
        const a =
          card.querySelector('a[href*="/v/auto-s/"]') ||
          card.querySelector('a[href*="/v/auto-s"], a[href*="/v/"]') ||
          card.querySelector('a[href]');
        const href = a ? a.getAttribute('href') : null;
        const url = href ? new URL(href, pageOrigin).href : null;

        // Titel
        const titleEl =
          card.querySelector('[data-testid="listing-title"], h3, h2') ||
          card.querySelector('a[title]');
        const title = titleEl ? titleEl.textContent.trim() : null;

        // Prijs
        const priceEl =
          card.querySelector('[data-testid="price-box-price"], .hz-Listing-price, [class*="price"]');
        const price = priceEl ? priceEl.textContent.replace(/[^\d.,]/g, '').trim() : null;

        // DATUM (vereist)
        const dateEl = card.querySelector('.hz-Listing-listingDate');
        const date = dateEl ? dateEl.textContent.trim() : null;

        // Locatie
        const locEl = card.querySelector('[data-testid="location-name"], .hz-Listing-location');
        const loc = locEl ? locEl.textContent.trim() : null;

        // adId
        let adId = null;
        if (url) {
          const m = url.match(/m(\d+)-/); // m2306520700-...
          if (m) adId = m[1];
          const m2 = url.match(/\/(\d{9,})/);
          if (!adId && m2) adId = m2[1];
        }

        return { url, title, price, loc, date, adId };
      };

      for (const card of cards) {
        // Alleen doorlaten als er een listingDate aanwezig is
        if (!card.querySelector('.hz-Listing-listingDate')) continue;

        // Minimale validatie
        const data = extract(card);
        if (data && data.url && data.title) return data;
      }
      return null;
    });

    if (!result) throw new Error('Geen niet-gesponsorde kaart met datum gevonden.');

    return {
      ...result,
      title: clean(result.title),
      price: clean(result.price),
      location: clean(result.loc),
      date: clean(result.date),
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
    if (await btn.isVisible({ timeout: 2500 })) {
      await btn.click();
      return;
    }
  } catch {}
  // 2) “Doorgaan zonder te accepteren”
  try {
    const noBtn = page.locator('button:has-text("Doorgaan zonder te accepteren")');
    if (await noBtn.first().isVisible({ timeout: 2000 })) {
      await noBtn.first().click();
      return;
    }
  } catch {}
  // 3) “Accepteren”
  try {
    const acc = page.locator('button:has-text("Accepteren")');
    if (await acc.first().isVisible({ timeout: 2000 })) {
      await acc.first().click();
      return;
    }
  } catch {}
}
