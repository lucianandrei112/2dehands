import { chromium } from 'playwright';

const DEFAULT_TIMEOUT = 25000;
const clean = (s) => (s ?? '').replace(/\s+/g, ' ').trim() || null;

export async function getFirstOrganicListing(listUrl, logger) {
  const browser = await chromium.launch(); // base image = headless OK
  const context = await browser.newContext({
    locale: 'nl-BE',
    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();

  try {
    logger?.info({ listUrl }, 'Navigating to list URL');
    await page.goto(listUrl, { waitUntil: 'domcontentloaded', timeout: DEFAULT_TIMEOUT });

    // Cookie banner (OneTrust) wegklikken – meerdere fallbacks
    await dismissCookies(page);

    // Wacht op eerste listings
    await page.waitForSelector('li.hz-Listing', { timeout: DEFAULT_TIMEOUT });

    // Klein scrolltje voor lazy content
    await page.evaluate(() => window.scrollBy(0, 800));
    await page.waitForTimeout(400);

    const result = await page.$$eval('li.hz-Listing', (cards) => {
      const isSponsored = (card) => {
        // 1) badge klasse
        if (card.querySelector('.hz-Listing-priority')) return true;
        // 2) tekstuele labels
        const t = (card.innerText || '').toLowerCase();
        if (/(topzoekertje|topadvertentie|advertentie|gesponsord)/i.test(t)) return true;
        return false;
      };

      const extract = (card) => {
        // Link naar detail
        const a =
          card.querySelector('a[href*="/v/auto-s/"]') ||
          card.querySelector('a[href*="/v/auto-s"], a[href*="/v/"]');
        const url = a ? new URL(a.href, location.origin).href : null;

        // Titel
        const titleEl = card.querySelector('[data-testid="listing-title"], h3, h2');
        const title = titleEl ? titleEl.textContent.trim() : null;

        // Prijs
        const priceEl =
          card.querySelector('[data-testid="price-box-price"], .hz-Listing-price, [class*="price"]');
        const price = priceEl ? priceEl.textContent.replace(/[^\d.,]/g, '').trim() : null;

        // Datum/locatie (optioneel)
        const dateEl = card.querySelector('.hz-Listing-listingDate');
        const date = dateEl ? dateEl.textContent.trim() : null;

        const locationEl =
          card.querySelector('[data-testid="location-name"], .hz-Listing-location');
        const location = locationEl ? locationEl.textContent.trim() : null;

        // ID uit URL
        let adId = null;
        if (url) {
          const m = url.match(/m(\d+)-/); // m2306520700-...
          if (m) adId = m[1];
          const m2 = url.match(/\/(\d{9,})/);
          if (!adId && m2) adId = m2[1];
        }

        return { url, title, price, location, date, adId };
      };

      for (const card of cards) {
        // skip promo-li's zonder link
        if (!card.querySelector('a')) continue;
        if (!isSponsored(card)) {
          const data = extract(card);
          if (data.url && data.title) return data;
        }
      }
      return null;
    });

    if (!result) throw new Error('Geen niet-gesponsorde kaart gevonden.');

    return {
      ...result,
      title: clean(result.title),
      price: clean(result.price),
      location: clean(result.location),
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
  // 3) “Accepteren” (gele knop)
  try {
    const acc = page.locator('button:has-text("Accepteren")');
    if (await acc.first().isVisible({ timeout: 2000 })) {
      await acc.first().click();
      return;
    }
  } catch {}
}
