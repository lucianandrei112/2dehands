import { chromium } from 'playwright';

const DEFAULT_TIMEOUT = 20000; // 20s

// Hulpfuncties
const clean = (s) => (s ?? "").replace(/\s+/g, " ").trim() || null;

export async function getFirstOrganicListing(listUrl, logger) {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    locale: 'nl-BE',
  });
  const page = await context.newPage();

  try {
    logger?.info({ listUrl }, 'Navigating to list URL');
    await page.goto(listUrl, { waitUntil: 'domcontentloaded', timeout: DEFAULT_TIMEOUT });

    // Cookie banner (OneTrust) wegklikken
    try {
      // 1) standaard OneTrust id
      const btn = page.locator('#onetrust-accept-btn-handler');
      if (await btn.isVisible({ timeout: 3000 })) await btn.click();
    } catch {}
    try {
      // 2) fallback op knoptekst
      const anyAccept = page.locator('button:has-text("Akkoord"), button:has-text("Accepteren"), button:has-text("Accept")');
      if (await anyAccept.first().isVisible({ timeout: 3000 })) await anyAccept.first().click();
    } catch {}

    // Wacht tot de lijst met kaarten zichtbaar is
    await page.waitForSelector('li.hz-Listing', { timeout: DEFAULT_TIMEOUT });

    // Extra: zorg dat lazy content geladen is (klein scrolltje)
    await page.evaluate(() => window.scrollBy(0, 800));
    await page.waitForTimeout(500);

    // Haal de eerste NIET-gesponsorde kaart op
    const cardData = await page.$$eval('li.hz-Listing', (cards) => {
      // Detectie van gesponsord:
      // - .hz-Listing-priority (Topzoekertje etc.)
      // - Tekstlabels “Topadvertentie”, “Advertentie”, “Gesponsord” (fallback)
      // - Eventuele data-testid / aria-label varianten
      const isSponsored = (card) => {
        if (card.querySelector('.hz-Listing-priority')) return true;
        const txt = (card.innerText || "").toLowerCase();
        if (/(topzoekertje|topadvertentie|advertentie|gesponsord)/i.test(txt)) return true;
        // Soms staan promo-blokken zonder prijs/titel
        return false;
      };

      const extract = (card) => {
        // link
        const a = card.querySelector('a[href*="/v/auto-s/"]') || card.querySelector('a[href*="/v/auto-s"], a[href*="/v/"]');
        const url = a ? new URL(a.href, location.origin).href : null;

        // titel
        const titleEl = card.querySelector('[data-testid="listing-title"], h3, h2');
        const title = titleEl ? titleEl.textContent.trim() : null;

        // prijs
        const priceEl = card.querySelector('[data-testid="price-box-price"], .hz-Listing-price, [class*="price"]');
        const price = priceEl ? priceEl.textContent.replace(/[^\d.,]/g, '').trim() : null;

        // meta (locatie, datum)
        const dateEl = card.querySelector('.hz-Listing-listingDate');
        const date = dateEl ? dateEl.textContent.trim() : null;

        const locationEl = card.querySelector('[data-testid="location-name"], .hz-Listing-location');
        const location = locationEl ? locationEl.textContent.trim() : null;

        // adId uit url
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
        // Vaak staan er “promo” li’s zonder echte inhoud; sla over
        if (!card.querySelector('a')) continue;

        if (!isSponsored(card)) {
          const data = extract(card);
          // valide: heeft url en titel
          if (data.url && data.title) return data;
        }
      }
      return null;
    });

    if (!cardData) {
      throw new Error('Geen niet-gesponsorde kaart gevonden.');
    }

    // Optioneel: extra details van de detailpagina halen
    // (Snelste MVP: return enkel data van de lijstkaart)
    return {
      ...cardData,
      scrapedAt: new Date().toISOString(),
      listUrlUsed: listUrl,
    };

  } finally {
    await context.close();
    await browser.close();
  }
}
