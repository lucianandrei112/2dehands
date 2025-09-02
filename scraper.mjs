import { chromium } from 'playwright';

const NAV_TIMEOUT = 10000;
const SHORT_TIMEOUT = 600;
const MAX_CARDS = Number(process.env.MAX_CARDS || 25);
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

/** Launch once & reuse. Relaunch when disconnected/crashed. */
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
  let context, page;

  try {
    context = await b.newContext({ locale: 'nl-BE', userAgent: UA, deviceScaleFactor: 1 });
    page = await context.newPage();

    // Altijd verse lijst laden
    const urlWithTs = listUrl + (listUrl.includes('?') ? '&' : '?') + `_ts=${Date.now()}`;

    logger?.debug?.({ urlWithTs }, 'goto');
    await page.goto(urlWithTs, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });

    await dismissCookies(page);
    await page.waitForSelector('li.hz-Listing', { timeout: NAV_TIMEOUT });

    // Zorg dat we écht bovenaan starten
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(120);

    // Kleine nudge om lazy render te triggeren
    await page.evaluate(() => window.scrollBy(0, 300));
    await page.waitForTimeout(120);

    // ===== BELANGRIJK: selecteer direct NIET-AD kaarten =====
    const nonAdCards = page.locator(
      'li.hz-Listing:has(.hz-Listing-listingDate):not(:has(.hz-Listing-priority))'
    );

    // Scroll net zolang tot we er minstens eentje zien of budget op is
    const t0 = Date.now();
    let lastCount = 0;
    while (Date.now() - t0 < SCROLL_BUDGET_MS && (await nonAdCards.count()) === 0) {
      const before = await nonAdCards.count();
      await page.evaluate((y) => window.scrollBy(0, y), SCROLL_STEP_PX);
      await page.waitForTimeout(200);
      const after = await nonAdCards.count();
      if (after >= MAX_CARDS) break;
      if (after === before && after === lastCount) await page.waitForTimeout(120);
      lastCount = after;
    }

    const total = Math.min(await nonAdCards.count(), MAX_CARDS);
    if (total === 0) throw new Error('Geen normale (niet-gesponsorde) kaart gevonden.');

    // Pak de allereerste NIET-AD kaart (deterministisch)
    const card = nonAdCards.first();
    await card.waitFor({ state: 'attached', timeout: NAV_TIMEOUT });

    // ---- Verplicht: url + titel
    const href =
      (await safeAttr(card, 'a[href*="/v/auto-s/"]', 'href')) ??
      (await safeAttr(card, 'a[href]', 'href'));
    const pageOrigin = await page.evaluate(() => globalThis.location.origin);
    const url = href ? new URL(href, pageOrigin).href : null;

    const title =
      (await safeText(card, '[data-testid="listing-title"], h3, h2, a[title]')) ||
      (await safeText(card, 'a[title]'));

    if (!url || !title) throw new Error('Kaart onvolledig (geen url/titel).');

    // ---- Optioneel (best-effort)
    const priceRaw = await safeText(
      card,
      '[data-testid="price-box-price"], .hz-Listing-price, [class*="price"]'
    );
    const priceEUR = parsePriceEUR(priceRaw);
    const date = await safeText(card, '.hz-Listing-listingDate');

    // Icon-rij: jaar/km/brandstof/transmissie/carrosserie
    const attrTexts = await safeTexts(card, '.hz-Attribute.hz-Attribute--default');
    const { year, mileageKm, fuel, transmission, body } = classifyAttributes(attrTexts);

    // Opties
    const optionsText = await safeText(card, '.hz-Listing-attribute-options');
    const options = optionsText ? optionsText.split(',').map((t) => clean(t)).filter(Boolean) : null;

    // Verkoper + stad
    const sellerName = await safeText(card, '.hz-Listing-seller-name');
    const sellerCity = await safeText(card, '.hz-Listing-sellerLocation');

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
    try { if (page) await page.close(); } catch {}
    try { if (context) await context.close(); } catch {}
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
  const transmissions = ['automaat','automatic','automatisch','boite auto','boîte auto','boite automatique','boîte automatische','handgeschakeld','manueel','manuelle','boite manuelle','boîte manuelle','semi-automaat','semi automaat'];
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
