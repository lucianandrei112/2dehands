import { chromium } from 'playwright';

const NAV_TIMEOUT = 9000;
const SHORT_TIMEOUT = 500;
const MAX_SCROLL_STEPS = Number(process.env.MAX_SCROLL_STEPS || 10);
const SCROLL_STEP_PX   = Number(process.env.SCROLL_STEP_PX || 1200);
const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36';

const clean = (s) => (s ?? '').replace(/\s+/g, ' ').trim() || null;

let browser;

/* ---------------- Browser lifecycle ---------------- */

async function launchBrowser() {
  const launchArgs = (process.env.PLAYWRIGHT_CHROMIUM_ARGS || '')
    .split(' ')
    .filter(Boolean);
  browser = await chromium.launch({
    headless: true,
    args: launchArgs.length
      ? launchArgs
      : ['--no-sandbox', '--disable-dev-shm-usage', '--single-process', '--no-zygote'],
  });
  return browser;
}

export async function ensureBrowser() {
  if (!browser || (typeof browser.isConnected === 'function' && !browser.isConnected())) {
    try { if (browser) await browser.close(); } catch {}
    await launchBrowser();
  }
  return browser;
}

export async function closeBrowser() {
  try { if (browser) await browser.close(); } catch {}
  browser = null;
}

/* ---------------- Main API ---------------- */

export async function getFirstOrganicListing(listUrl, logger) {
  try {
    return await doScrape(listUrl, logger);
  } catch (err) {
    const msg = String(err?.message || err);
    // Als de browser/context net werd gesloten → één keer herstarten en opnieuw
    if (/Target .* (closed|crash)|has been closed|browser has been closed/i.test(msg)) {
      await closeBrowser();
      await ensureBrowser();
      return await doScrape(listUrl, logger);
    }
    throw err;
  }
}

/* ---------------- Implementation ---------------- */

async function doScrape(listUrl, logger) {
  const b = await ensureBrowser();
  const context = await b.newContext({ locale: 'nl-BE', userAgent: UA });

  // Blokkeer zware assets (snel en RAM-vriendelijk)
  await context.route('**/*', (route) => {
    const rt = route.request().resourceType();
    if (rt === 'image' || rt === 'font' || rt === 'media') return route.abort();
    return route.continue();
  });

  const page = await context.newPage();

  try {
    // cache-buster: altijd verse resultaten
    const url = listUrl + (listUrl.includes('?') ? '&' : '?') + `_ts=${Date.now()}`;
    logger?.debug?.({ url }, 'goto');
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });

    await dismissCookies(page);

    // wacht tot er tenminste cards in de DOM staan
    await page.waitForSelector('li.hz-Listing', { timeout: NAV_TIMEOUT });

    // progressive scan: zoek onze kaart; zo niet -> scroll en opnieuw
    const selector = 'li.hz-Listing:has(.hz-Listing-listingDate):not(:has(.hz-Listing-priority))';

    let card;
    for (let i = 0; i <= MAX_SCROLL_STEPS; i++) {
      const count = await page.locator(selector).count();
      if (count > 0) {
        card = page.locator(selector).first();
        break;
      }
      // scroll klein stukje en korte pauze
      await page.evaluate((y) => window.scrollBy(0, y), SCROLL_STEP_PX);
      await page.waitForTimeout(120);
    }

    if (!card) throw new Error('Geen normale (niet-gesponsorde) kaart zichtbaar na scroll.');

    // -------- Extract (snel & best effort)
    const href =
      (await safeAttr(card, 'a[href*="/v/auto-s/"]', 'href')) ??
      (await safeAttr(card, 'a[href]', 'href'));

    const pageOrigin = await page.evaluate(() => globalThis.location.origin);
    const absUrl = href ? new URL(href, pageOrigin).href : null;

    const title =
      (await safeText(card, '[data-testid="listing-title"], h3, h2, a[title]')) ||
      (await safeText(card, 'a[title]'));

    if (!absUrl || !title) throw new Error('Kaart onvolledig (geen url/titel).');

    const priceRaw = await safeText(
      card,
      '[data-testid="price-box-price"], .hz-Listing-price, [class*="price"]'
    );
    const priceEUR = parsePriceEUR(priceRaw);

    const date = await safeText(card, '.hz-Listing-listingDate');

    // icon rij
    const attrTexts = await safeTexts(card, '.hz-Attribute.hz-Attribute--default');
    const { year, mileageKm, fuel, transmission, body } = classifyAttributes(attrTexts);

    // opties + verkoper
    const optionsText = await safeText(card, '.hz-Listing-attribute-options');
    const options = optionsText ? optionsText.split(',').map((t) => clean(t)).filter(Boolean) : null;

    const sellerName = await safeText(card, '.hz-Listing-seller-name');
    const sellerCity = await safeText(card, '.hz-Listing-sellerLocation');

    // adId uit URL
    let adId = null;
    if (absUrl) {
      const m = absUrl.match(/m(\d+)-/);
      if (m) adId = m[1];
      const m2 = absUrl.match(/\/(\d{9,})/);
      if (!adId && m2) adId = m2[1];
    }

    return {
      url: absUrl,
      title: clean(title),
      priceRaw: clean(priceRaw),
      priceEUR,
      date: clean(date),
      adId,
      year,
      mileageKm,
      fuel,
      transmission,
      body,
      options,
      sellerName: clean(sellerName),
      sellerCity: clean(sellerCity),
      scrapedAt: new Date().toISOString(),
      listUrlUsed: listUrl,
    };
  } finally {
    try { await page.close(); } catch {}
    try { await context.close(); } catch {}
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

function parsePriceEUR(raw) {
  if (!raw) return null;
  const digits = raw.replace(/[^\d]/g, '');
  return digits ? parseInt(digits, 10) : null;
}
function parseKm(raw) {
  if (!raw) return null;
  const m = raw.match(/([\d.\s]+)\s*km/i);
  if (!m) return null;
  const digits = m[1].replace(/[^\d]/g, '');
  return digits ? parseInt(digits, 10) : null;
}

function classifyAttributes(items) {
  const norm = (s) =>
    (s || '').toString().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

  const fuels = [
    'diesel','benzine','essence','petrol','elektrisch','electrique','electric',
    'hybride','hybrid','plug-in hybride','plugin hybride','cng','lpg'
  ];
  const transmissions = [
    'automaat','automatic','automatisch','boite auto','boîte auto','boite automatique',
    'boîte automatique','handgeschakeld','manueel','manuelle','boite manuelle',
    'boîte manuelle','semi-automaat','semi automaat'
  ];
  const bodies = [
    'berline','sedan','hatchback','break','station','stationwagen','stationwagon',
    'suv','coupe','coupé','cabri','cabrio','cabriolet','mpv','monovolume',
    'pick-up','pickup','bestelwagen','bestel','coupé'
  ];

  let year = null, mileageKm = null, fuel = null, transmission = null, body = null;

  for (const raw of items) {
    const t = norm(raw);

    const y = (raw.match(/(?:19|20)\d{2}/) || [])[0];
    if (!year && y && +y >= 1950 && +y <= 2035) year = y;

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
    if (await btn.isVisible({ timeout: 700 })) { await btn.click(); return; }
  } catch {}
  try {
    const noBtn = page.locator('button:has-text("Doorgaan zonder te accepteren"), button:has-text("Continuer sans accepter")');
    if (await noBtn.first().isVisible({ timeout: 500 })) { await noBtn.first().click(); return; }
  } catch {}
  try {
    const acc = page.locator('button:has-text("Accepteren"), button:has-text("Accepter")');
    if (await acc.first().isVisible({ timeout: 500 })) { await acc.first().click(); return; }
  } catch {}
}
