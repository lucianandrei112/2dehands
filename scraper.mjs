import { chromium } from 'playwright';

const NAV_TIMEOUT = 10000;            // snel falen i.p.v. hangen
const SHORT_TIMEOUT = 600;
const SCROLL_BUDGET_MS = Number(process.env.SCROLL_BUDGET_MS || 7000);
const SCROLL_STEP_PX = Number(process.env.SCROLL_STEP_PX || 2000);

const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36';

const clean = (s) => (s ?? '').replace(/\s+/g, ' ').trim() || null;

let browser;

/* ------------ Browser lifecycle (reliable) ------------ */
async function launchBrowser() {
  const launchArgs = (process.env.PLAYWRIGHT_CHROMIUM_ARGS || '')
    .split(' ')
    .filter(Boolean);
  browser = await chromium.launch({
    headless: true,
    args: launchArgs.length
      ? launchArgs
      : ['--no-sandbox', '--disable-dev-shm-usage', '--single-process', '--no-zygote', '--disable-gpu'],
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

/* ------------ Main scrape with 1 automatic retry ------------ */
export async function getFirstOrganicListing(listUrl, logger) {
  try {
    return await doScrape(listUrl, logger);
  } catch (err) {
    const msg = String(err?.message || err);
    if (/Target .* (closed|crash)|has been closed|browser has been closed/i.test(msg)) {
      await closeBrowser();
      await ensureBrowser();
      return await doScrape(listUrl, logger);
    }
    throw err;
  }
}

async function doScrape(listUrl, logger) {
  const b = await ensureBrowser();

  // Nieuwe context per request (geen staat tussen requests)
  const context = await b.newContext({
    locale: 'nl-BE',
    userAgent: UA,
    extraHTTPHeaders: {
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
    },
  });

  // Voor elk document: voorkom client cache/persoonlijke state
  await context.addInitScript(() => {
    try { localStorage.clear(); } catch {}
    try { sessionStorage.clear(); } catch {}
  });

  // Sneller en stabieler: zware assets niet laden
  await context.route('**/*', (route) => {
    const rt = route.request().resourceType();
    if (rt === 'image' || rt === 'font' || rt === 'media') return route.abort();
    return route.continue();
  });

  const page = await context.newPage();

  try {
    // Cache-buster → elke run verse lijst
    const urlWithTs = listUrl + (listUrl.includes('?') ? '&' : '?') +
      `_ts=${Date.now()}_${Math.random().toString(36).slice(2)}`;

    logger?.debug?.({ urlWithTs }, 'goto');
    await page.goto(urlWithTs, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });

    await dismissCookies(page);

    // begin écht bovenaan
    await page.waitForSelector('li.hz-Listing', { timeout: NAV_TIMEOUT });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(120);

    // ——— de allereerste NIET-ad kaart met datum ———
    const nonAdSelector = [
      'li.hz-Listing:has(.hz-Listing-listingDate)',
      ':not(:has(.hz-Listing-priority))',
      ':not(:has-text("Topadvertentie"))',
      ':not(:has-text("Topzoekertje"))',
      ':not(:has-text("Gesponsord"))',
      ':not(:has-text("Sponsored"))',
      ':not(:has-text("Publicité"))',
      ':not(:has-text("Annonce sponsorisée"))'
    ].join('');

    let cardLoc = page.locator(nonAdSelector).first();

    // als het nog niet zichtbaar is → kort scrollen en opnieuw proberen (binnen budget)
    const t0 = Date.now();
    while (await cardLoc.count() === 0 && Date.now() - t0 < SCROLL_BUDGET_MS) {
      await page.evaluate((y) => window.scrollBy(0, y), SCROLL_STEP_PX);
      await page.waitForTimeout(180);
      cardLoc = page.locator(nonAdSelector).first();
    }

    if (await cardLoc.count() === 0) {
      throw new Error('Geen normale (niet-gesponsorde) kaart gevonden.');
    }

    await cardLoc.waitFor({ state: 'attached', timeout: NAV_TIMEOUT });

    // ---- verplichte velden
    const href =
      (await safeAttr(cardLoc, 'a[href*="/v/auto-s/"]', 'href')) ??
      (await safeAttr(cardLoc, 'a[href]', 'href'));
    const pageOrigin = await page.evaluate(() => globalThis.location.origin);
    const url = href ? new URL(href, pageOrigin).href : null;

    const title =
      (await safeText(cardLoc, '[data-testid="listing-title"], h3, h2, a[title]')) ||
      (await safeText(cardLoc, 'a[title]'));

    if (!url || !title) throw new Error('Kaart onvolledig (geen url/titel).');

    // ---- optioneel (best-effort)
    const priceRaw = await safeText(
      cardLoc,
      '[data-testid="price-box-price"], .hz-Listing-price, [class*="price"]'
    );
    const priceEUR = parsePriceEUR(priceRaw);
    const date = await safeText(cardLoc, '.hz-Listing-listingDate');

    const attrTexts = await safeTexts(cardLoc, '.hz-Attribute.hz-Attribute--default');
    const { year, mileageKm, fuel, transmission, body } = classifyAttributes(attrTexts);

    const optionsText = await safeText(cardLoc, '.hz-Listing-attribute-options');
    const options = optionsText ? optionsText.split(',').map((t) => clean(t)).filter(Boolean) : null;

    const sellerName = await safeText(cardLoc, '.hz-Listing-seller-name');
    const sellerCity = await safeText(cardLoc, '.hz-Listing-sellerLocation');

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
  } finally {
    try { await page.close(); } catch {}
    try { await context.close(); } catch {}
  }
}

/* ---------- helpers ---------- */
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
  const norm = (s) => (s || '').toString().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const fuels = ['diesel','benzine','essence','petrol','elektrisch','electrique','electric','hybride','hybrid','plug-in hybride','plugin hybride','cng','lpg'];
  const transmissions = ['automaat','automatic','automatisch','boite auto','boîte auto','boite automatique','boîte automatique','handgeschakeld','manueel','manuelle','boite manuelle','boîte manuelle','semi-automaat','semi automaat'];
  const bodies = ['berline','sedan','hatchback','break','station','stationwagen','stationwagon','suv','coupe','coupé','cabri','cabrio','cabriolet','mpv','monovolume','pick-up','pickup','bestelwagen','bestel','coupé'];

  let year=null, mileageKm=null, fuel=null, transmission=null, body=null;

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
