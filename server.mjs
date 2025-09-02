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

    // laat badges/render even “settlen”
    await page.waitForSelector('li.hz-Listing', { timeout: DEFAULT_TIMEOUT });
    await page.waitForLoadState('networkidle', { timeout: DEFAULT_TIMEOUT }).catch(() => {});
    await page.evaluate(() => window.scrollBy(0, 1200));
    await page.waitForTimeout(350);

    // Kandidaten: MET datum
    const candidates = page.locator('li.hz-Listing:has(.hz-Listing-listingDate)');
    const total = await candidates.count();

    for (let i = 0; i < Math.min(total, 25); i++) {
      const card = candidates.nth(i);
      await card.waitFor({ state: 'attached', timeout: DEFAULT_TIMEOUT });
      await page.waitForTimeout(120);

      // Skip topadvertenties/gesponsord
      const hasPriority = (await card.locator('.hz-Listing-priority').count()) > 0;
      let txt = '';
      try { txt = ((await card.textContent({ timeout: SHORT_TIMEOUT })) || '').toLowerCase(); } catch {}
      const looksSponsored =
        hasPriority ||
        txt.includes('topadvertentie') ||
        txt.includes('topzoekertje') ||
        txt.includes('gesponsord') ||
        /\badvertentie\b/.test(txt);
      if (looksSponsored) continue;

      // --------- Extract verplichte velden
      const href =
        (await safeAttr(card, 'a[href*="/v/auto-s/"]', 'href')) ??
        (await safeAttr(card, 'a[href]', 'href'));
      const pageOrigin = await page.evaluate(() => globalThis.location.origin);
      const url = href ? new URL(href, pageOrigin).href : null;

      const title =
        (await getText(card, '[data-testid="listing-title"], h3, h2, a[title]')) ||
        (await getText(card, 'a[title]'));

      if (!url || !title) continue;

      // --------- Extract optionele velden
      const rawPrice = await getText(
        card,
        '[data-testid="price-box-price"], .hz-Listing-price, [class*="price"]'
      );
      const date = await getText(card, '.hz-Listing-listingDate');

      // Attributen (bouwjaar, brandstof, transmissie, carrosserie)
      const attrTexts = await getTexts(card, '.hz-Attribute.hz-Attribute--default');
      const { year, fuel, transmission, body } = classifyAttributes(attrTexts);

      // Opties
      const optionsText = await getText(card, '.hz-Listing-attribute-options');
      const options = optionsText
        ? optionsText.split(',').map((t) => clean(t)).filter(Boolean)
        : null;

      // Verkoper + stad
      const sellerName = await getText(card, '.hz-Listing-seller-name');
      const sellerCity = await getText(card, '.hz-Listing-sellerLocation');

      // adId uit URL
      let adId = null;
      if (url) {
        const m = url.match(/m(\d+)-/);
        if (m) adId = m[1];
        const m2 = url.match(/\/(\d{9,})/);
        if (!adId && m2) adId = m2[1];
      }

      return {
        url,
        title: clean(title),
        price: rawPrice ? clean(rawPrice.replace(/[^\d.,]/g, '')) : null,
        location: null,            // (oude field laten staan voor backward compat)
        date: clean(date),
        adId,
        // Nieuwe velden:
        year,
        fuel,
        transmission,
        body,
        options,
        sellerName: clean(sellerName),
        sellerCity: clean(sellerCity),
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

// ---------- Helpers ----------

// tekst van 1 element (of null)
async function getText(scope, selector) {
  try {
    const loc = scope.locator(selector).first();
    if ((await loc.count()) === 0) return null;
    const txt = await loc.textContent({ timeout: SHORT_TIMEOUT });
    return txt ? txt.replace(/\s+/g, ' ').trim() : null;
  } catch {
    return null;
  }
}

// attribuutwaarde (of null)
async function safeAttr(scope, selector, attr) {
  try {
    const loc = scope.locator(selector).first();
    if ((await loc.count()) === 0) return null;
    const val = await loc.getAttribute(attr, { timeout: SHORT_TIMEOUT });
    return val ?? null;
  } catch {
    return null;
  }
}

// teksten van meerdere elementen
async function getTexts(scope, selector) {
  try {
    const loc = scope.locator(selector);
    const n = await loc.count();
    const arr = [];
    for (let i = 0; i < n; i++) {
      const t = await loc.nth(i).textContent({ timeout: SHORT_TIMEOUT }).catch(() => null);
      if (t) arr.push(t.replace(/\s+/g, ' ').trim());
    }
    return arr;
  } catch {
    return [];
  }
}

// map de attributenlijst naar year/fuel/transmission/body
function classifyAttributes(items) {
  const norm = (s) =>
    (s || '')
      .toString()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();

  const fuels = [
    'diesel', 'benzine', 'benzin', 'electric', 'elektrisch',
    'hybride', 'plug-in hybride', 'plugin hybride', 'cng', 'lpg'
  ];
  const transmissions = [
    'automaat', 'automatic', 'automatisch', 'handgeschakeld', 'manueel',
    'semi-automaat', 'semi automaat'
  ];
  const bodies = [
    'berline', 'sedan', 'hatchback', 'break', 'station', 'stationwagen', 'stationwagon',
    'suv', 'coupe', 'coupé', 'cabrio', 'cabriolet', 'mpv', 'monovolume',
    'pick-up', 'pickup', 'bestelwagen', 'bestel'
  ];

  let year = null, fuel = null, transmission = null, body = null;

  for (const raw of items) {
    const t = norm(raw);

    // jaar (pak eerste geldige 4-digit tussen 1950..2035)
    const y = (raw.match(/(?:19|20)\d{2}/) || [])[0];
    if (!year && y && +y >= 1950 && +y <= 2035) year = y;

    if (!fuel && fuels.some((k) => t.includes(k))) fuel = raw.trim();
    if (!transmission && transmissions.some((k) => t.includes(k))) transmission = raw.trim();
    if (!body && bodies.some((k) => t.includes(k))) body = raw.trim();
  }

  return {
    year: year ? String(year) : null,
    fuel: fuel ? clean(fuel) : null,
    transmission: transmission ? clean(transmission) : null,
    body: body ? clean(body) : null
  };
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
