import { chromium } from 'playwright';

const DEFAULT_TIMEOUT = 12000;
const SHORT_TIMEOUT = 700;
const clean = (s) => (s ?? '').replace(/\s+/g, ' ').trim() || null;

export async function getFirstOrganicListing(listUrl, logger) {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    locale: 'nl-BE',
    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  try {
    logger?.info({ listUrl }, 'goto');
    await page.goto(listUrl, { waitUntil: 'domcontentloaded', timeout: DEFAULT_TIMEOUT });

    await dismissCookies(page);

    await page.waitForSelector('li.hz-Listing', { timeout: DEFAULT_TIMEOUT });
    await page.evaluate(() => window.scrollBy(0, 800));
    await page.waitForTimeout(200);

    const candidates = page.locator('li.hz-Listing:has(.hz-Listing-listingDate)');
    const total = Math.min(await candidates.count(), 15);

    for (let i = 0; i < total; i++) {
      const card = candidates.nth(i);
      await card.waitFor({ state: 'attached', timeout: DEFAULT_TIMEOUT });

      // Skip Topadvertenties/gesponsord (badge + tekst)
      const hasPriority = (await safeCount(card, '.hz-Listing-priority')) > 0;
      const txt = ((await safeText(card, ':scope')) || '').toLowerCase();
      const looksSponsored =
        hasPriority ||
        txt.includes('topadvertentie') ||
        txt.includes('topzoekertje') ||
        txt.includes('gesponsord') ||
        /\badvertentie\b/.test(txt);
      if (looksSponsored) continue;

      // Verplichte velden
      const href =
        (await safeAttr(card, 'a[href*="/v/auto-s/"]', 'href')) ??
        (await safeAttr(card, 'a[href]', 'href'));
      const pageOrigin = await page.evaluate(() => globalThis.location.origin);
      const url = href ? new URL(href, pageOrigin).href : null;

      const title =
        (await safeText(card, '[data-testid="listing-title"], h3, h2, a[title]')) ||
        (await safeText(card, 'a[title]'));

      if (!url || !title) continue;

      // Optionele velden
      const priceRaw = await safeText(
        card,
        '[data-testid="price-box-price"], .hz-Listing-price, [class*="price"]'
      );
      const priceEUR = parsePriceEUR(priceRaw);

      const date = await safeText(card, '.hz-Listing-listingDate');

      // Attributen (icon-lijstje)
      const attrTexts = await safeTexts(card, '.hz-Attribute.hz-Attribute--default');
      const { year, mileageKm, fuel, transmission, body } = classifyAttributes(attrTexts);

      // Opties
      const optionsText = await safeText(card, '.hz-Listing-attribute-options');
      const options = optionsText
        ? optionsText.split(',').map((t) => clean(t)).filter(Boolean)
        : null;

      // Verkoper + stad
      const sellerName = await safeText(card, '.hz-Listing-seller-name');
      const sellerCity = await safeText(card, '.hz-Listing-sellerLocation');

      // adId uit url
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
        priceRaw: clean(priceRaw),
        priceEUR,                 // genormaliseerd (nummer), bv. 10000
        date: clean(date),
        adId,
        year,
        mileageKm,                // bv. 29000
        fuel,
        transmission,
        body,
        options,                  // array, bv. ["Cruise Control", "Bluetooth", "Navigatiesysteem"]
        sellerName: clean(sellerName),
        sellerCity: clean(sellerCity),
        scrapedAt: new Date().toISOString(),
        listUrlUsed: listUrl,
      };
    }

    throw new Error('Geen normale (niet-gesponsorde) kaart gevonden in de eerste 15.');
  } finally {
    await context.close();
    await browser.close();
  }
}

/* ---------------- helpers ---------------- */

async function safeText(scope, selector) {
  try {
    const loc = scope.locator(selector).first();
    if ((await loc.count()) === 0) return null;
    const t = await loc.textContent({ timeout: SHORT_TIMEOUT });
    return t ? t.replace(/\s+/g, ' ').trim() : null;
  } catch { return null; }
}
async function safeAttr(scope, selector, attr) {
  try {
    const loc = scope.locator(selector).first();
    if ((await loc.count()) === 0) return null;
    return await loc.getAttribute(attr, { timeout: SHORT_TIMEOUT });
  } catch { return null; }
}
async function safeTexts(scope, selector) {
  try {
    const loc = scope.locator(selector);
    const n = await loc.count();
    const out = [];
    for (let i = 0; i < n; i++) {
      const t = await loc.nth(i).textContent({ timeout: SHORT_TIMEOUT }).catch(() => null);
      if (t) out.push(t.replace(/\s+/g, ' ').trim());
    }
    return out;
  } catch { return []; }
}
async function safeCount(scope, selector) {
  try { return await scope.locator(selector).count(); } catch { return 0; }
}

function parsePriceEUR(raw) {
  if (!raw) return null;
  const digits = raw.replace(/[^\d]/g, '');
  return digits ? parseInt(digits, 10) : null;
}
function parseKm(raw) {
  if (!raw) return null;
  // vang “29.000 km”, “29000km”, “29 000 KM”
  const m = raw.match(/([\d.\s]+)\s*km/i);
  if (!m) return null;
  const digits = m[1].replace(/[^\d]/g, '');
  return digits ? parseInt(digits, 10) : null;
}

function classifyAttributes(items) {
  const norm = (s) =>
    (s || '').toString().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

  // NL/FR/EN varianten
  const fuels = [
    'diesel','benzine','essence','petrol','elektrisch','electrique','electric',
    'hybride','hybrid','plug-in hybride','plugin hybride','cng','lpg'
  ];
  const transmissions = [
    'automaat','automatic','automatisch','boite auto','boîte auto','boite automatique','boîte automatique',
    'handgeschakeld','manueel','manuelle','boite manuelle','boîte manuelle','semi-automaat','semi automaat'
  ];
  const bodies = [
    'berline','sedan','hatchback','break','station','stationwagen','stationwagon',
    'suv','coupe','coupé','cabri','cabrio','cabriolet','mpv','monovolume',
    'pick-up','pickup','bestelwagen','bestel','coupé'
  ];

  let year = null, mileageKm = null, fuel = null, transmission = null, body = null;

  for (const raw of items) {
    const t = norm(raw);

    // jaar 1950–2035
    const y = (raw.match(/(?:19|20)\d{2}/) || [])[0];
    if (!year && y && +y >= 1950 && +y <= 2035) year = y;

    // km
    if (!mileageKm) {
      const km = parseKm(raw);
      if (km) mileageKm = km;
    }

    if (!fuel && fuels.some((k) => t.includes(k))) fuel = clean(raw);
    if (!transmission && transmissions.some((k) => t.includes(k))) transmission = clean(raw);
    if (!body && bodies.some((k) => t.includes(k))) body = clean(raw);
  }

  return {
    year: year ? String(year) : null,
    mileageKm: mileageKm ?? null,
    fuel: fuel ?? null,
    transmission: transmission ?? null,
    body: body ?? null,
  };
}

async function dismissCookies(page) {
  try {
    const btn = page.locator('#onetrust-accept-btn-handler');
    if (await btn.isVisible({ timeout: 1200 })) { await btn.click(); return; }
  } catch {}
  try {
    // NL + FR fallback
    const noBtn = page.locator('button:has-text("Doorgaan zonder te accepteren"), button:has-text("Continuer sans accepter")');
    if (await noBtn.first().isVisible({ timeout: 800 })) { await noBtn.first().click(); return; }
  } catch {}
  try {
    const acc = page.locator('button:has-text("Accepteren"), button:has-text("Accepter")');
    if (await acc.first().isVisible({ timeout: 800 })) { await acc.first().click(); return; }
  } catch {}
}
