import { chromium } from 'playwright';

const NAV_TIMEOUT = 10000;      // snel falen i.p.v. hangen
const SHORT_TIMEOUT = 600;
const SCAN_BUDGET_MS = 9000;    // totale zoektijd op de pagina
const CHUNK_SCROLL_PX = 2000;   // per iteratie naar beneden scrollen
const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36';

const clean = (s) => (s ?? '').replace(/\s+/g, ' ').trim() || null;

let browser;

/** Launch once & reuse (voorkomt OOM/slow starts) */
export async function ensureBrowser() {
  if (browser) return browser;
  const launchArgs = (process.env.PLAYWRIGHT_CHROMIUM_ARGS || '')
    .split(' ')
    .filter(Boolean);
  browser = await chromium.launch({
    headless: true,
    args: launchArgs.length
      ? launchArgs
      : ['--no-sandbox', '--disable-dev-shm-usage', '--single-process'],
  });
  return browser;
}

export async function closeBrowser() {
  try { if (browser) await browser.close(); } catch {}
  browser = null;
}

export async function getFirstOrganicListing(listUrl, logger) {
  const b = await ensureBrowser();
  const context = await b.newContext({ locale: 'nl-BE', userAgent: UA });
  const page = await context.newPage();

  try {
    logger?.debug?.({ listUrl }, 'goto');
    await page.goto(listUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });

    await dismissCookies(page);

    await page.waitForSelector('li.hz-Listing', { timeout: NAV_TIMEOUT });

    // we zoeken alleen tussen KAARTEN MET DATUM en ZONDER priority-badge
    const nonAdCards = page.locator(
      'li.hz-Listing:has(.hz-Listing-listingDate):not(:has(.hz-Listing-priority))'
    );

    const t0 = Date.now();
    let scanned = 0;

    while (Date.now() - t0 < SCAN_BUDGET_MS) {
      // trigger lazy load
      await page.evaluate((y) => window.scrollBy(0, y), CHUNK_SCROLL_PX);
      await page.waitForTimeout(180);

      const count = await nonAdCards.count();
      for (let i = scanned; i < count; i++) {
        const card = nonAdCards.nth(i);

        // extra tekst-fallback: sommige badges zijn alleen tekst
        const lower = ((await safeText(card, ':scope')) || '').toLowerCase();
        if (
          lower.includes('topadvertentie') ||
          lower.includes('topzoekertje') ||
          lower.includes('gesponsord') ||
          /\badvertentie\b/.test(lower)
        ) {
          continue;
        }

        // ---- verplichte velden
        const href =
          (await safeAttr(card, 'a[href*="/v/auto-s/"]', 'href')) ??
          (await safeAttr(card, 'a[href]', 'href'));
        const pageOrigin = await page.evaluate(() => globalThis.location.origin);
        const url = href ? new URL(href, pageOrigin).href : null;

        const title =
          (await safeText(card, '[data-testid="listing-title"], h3, h2, a[title]')) ||
          (await safeText(card, 'a[title]'));

        if (!url || !title) continue;

        // ---- optionele velden
        const priceRaw = await safeText(
          card,
          '[data-testid="price-box-price"], .hz-Listing-price, [class*="price"]'
        );
        const priceEUR = parsePriceEUR(priceRaw);
        const date = await safeText(card, '.hz-Listing-listingDate');

        // icon-rij: jaar, km, brandstof, versnellingsbak, carrosserie
        const attrTexts = await safeTexts(card, '.hz-Attribute.hz-Attribute--default');
        const { year, mileageKm, fuel, transmission, body } = classifyAttributes(attrTexts);

        // opties
        const optionsText = await safeText(card, '.hz-Listing-attribute-options');
        const options = optionsText
          ? optionsText.split(',').map((t) => clean(t)).filter(Boolean)
          : null;

        // verkoper + stad
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
      }

      scanned = count;
    }

    throw new Error('Geen normale (niet-gesponsorde) kaart gevonden binnen het tijdsbudget.');
  } finally {
    await context.close(); // browser open houden voor volgende requests
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
    if (await btn.isVisible({ timeout: 800 })) { await btn.click(); return; }
  } catch {}
  try {
    const noBtn = page.locator('button:has-text("Doorgaan zonder te accepteren"), button:has-text("Continuer sans accepter")');
    if (await noBtn.first().isVisible({ timeout: 600 })) { await noBtn.first().click(); return; }
  } catch {}
  try {
    const acc = page.locator('button:has-text("Accepteren"), button:has-text("Accepter")');
    if (await acc.first().isVisible({ timeout: 600 })) { await acc.first().click(); return; }
  } catch {}
}
