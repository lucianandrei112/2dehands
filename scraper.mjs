import { chromium } from 'playwright';
import fs from 'node:fs';

// ---------- tuning ----------
const NAV_TIMEOUT = Number(process.env.NAV_TIMEOUT || 45000); // ruimer: geef XHR/filters tijd
const SHORT_TIMEOUT = 600;
const MAX_CARDS = Number(process.env.MAX_CARDS || 25);
const SCROLL_BUDGET_MS = Number(process.env.SCROLL_BUDGET_MS || 7000);
const SCROLL_STEP_PX = Number(process.env.SCROLL_STEP_PX || 2000);

// anti-rate-limit
const JITTER_MIN_MS = Number(process.env.JITTER_MIN_MS || 1200);
const JITTER_MAX_MS = Number(process.env.JITTER_MAX_MS || 4200);

// sessie & state
const STORAGE_PATH  = process.env.STORAGE_PATH  || '/tmp/2dehands_state.json'; // playwright storageState
const LAST_STATE_PATH = process.env.LAST_STATE_PATH || '/tmp/2dehands_last.json'; // eigen dedupe
const FRESH_SESSION = process.env.FRESH_SESSION === '1';

// UA
const UA_POOL = [
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36',
];
const UA = process.env.UA || UA_POOL[Math.floor(Math.random() * UA_POOL.length)];

const clean = (s) => (s ?? '').replace(/\s+/g, ' ').trim() || null;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const randInt = (a,b) => Math.floor(Math.random()*(b-a+1))+a;

let browser;

/* ------------ Browser lifecycle ------------ */
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
  let context, page;

  try {
    const storageState = (!FRESH_SESSION && fs.existsSync(STORAGE_PATH)) ? STORAGE_PATH : undefined;

    context = await b.newContext({
      locale: 'nl-BE',
      timezoneId: 'Europe/Brussels',
      userAgent: UA,
      deviceScaleFactor: 1,
      storageState,
      extraHTTPHeaders: {
        'Accept-Language': 'nl-BE,nl;q=0.9,fr-BE;q=0.8,fr;q=0.7,en;q=0.6',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
        'Referer': 'https://www.2dehands.be/',
      },
    });

    // zware assets blokkeren (sneller, minder opvallend)
    await context.route('**/*', (route) => {
      const rt = route.request().resourceType();
      if (rt === 'image' || rt === 'font' || rt === 'media') return route.abort();
      return route.continue();
    });

    page = await context.newPage();

    // kleine willekeurige pauze (jitter) → natuurlijker
    await sleep(randInt(JITTER_MIN_MS, JITTER_MAX_MS));

    // cache-buster vóór de hash, zo forceer je echt een verse lijst
    const urlWithTs = addCacheBuster(listUrl);
    logger?.debug?.({ urlWithTs }, 'goto');
    await page.goto(urlWithTs, { waitUntil: 'networkidle', timeout: NAV_TIMEOUT });

    await dismissCookies(page);
    await page.waitForSelector('li.hz-Listing', { timeout: NAV_TIMEOUT });

    // tiny scroll om lazy content te triggeren
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(120);
    await page.evaluate(() => window.scrollBy(0, 700));
    await page.waitForTimeout(150);

    // ---- WACHT TOT FILTERS/SORT ECHT ACTIEF ZIJN ----
    await waitForFiltersApplied(page);

    // ---- NU SCANNEN & PAKKEN ----
    const record = await scanFirstRecord(page);
    if (!record) throw new Error('Geen normale (niet-gesponsorde) kaart gevonden.');

    // de-dupe: als gelijk aan vorige → één reload-try
    const last = readLast();
    if (last?.adId && last.adId === record.adId) {
      await page.reload({ waitUntil: 'networkidle', timeout: NAV_TIMEOUT }).catch(() => {});
      await dismissCookies(page);
      await waitForFiltersApplied(page);
      const retry = await scanFirstRecord(page);
      if (retry && retry.adId !== record.adId) {
        writeLast({ adId: retry.adId, at: Date.now() });
        return retry;
      }
      // nog steeds hetzelfde: schrijf terug en geef door (caller kan zelf 204 doen)
      writeLast({ adId: record.adId, at: Date.now() });
      return { ...record, sameAsLast: true };
    }

    writeLast({ adId: record.adId, at: Date.now() });
    return record;

  } finally {
    // sessie/cookies bewaren (tenzij FRESH_SESSION)
    try { if (context && !FRESH_SESSION) await context.storageState({ path: STORAGE_PATH }); } catch {}

    try { if (page) await page.close(); } catch {}
    try { if (context) await context.close(); } catch {}
    // browser blijft open
  }
}

/* ---------- scan helpers ---------- */

async function scanFirstRecord(page) {
  // kaarten met datumlabel
  const datedCards = page.locator('li.hz-Listing:has(.hz-Listing-listingDate)');
  // Scroll door tot we genoeg kaarten zien of budget op is
  const t0 = Date.now();
  let lastCount = 0;
  while (Date.now() - t0 < SCROLL_BUDGET_MS) {
    const count = await datedCards.count().catch(() => 0);
    if (count >= MAX_CARDS) break;
    if (count === lastCount) await page.waitForTimeout(150);
    await page.evaluate((y) => window.scrollBy(0, y), SCROLL_STEP_PX);
    await page.waitForTimeout(220);
    lastCount = count;
  }

  const total = Math.min(await datedCards.count().catch(() => 0), MAX_CARDS);

  for (let i = 0; i < total; i++) {
    const card = datedCards.nth(i);
    try { await card.waitFor({ state: 'attached', timeout: NAV_TIMEOUT }); } catch { continue; }

    // Skip topadvertenties/gesponsord (badge + tekst)
    const hasPriority = (await safeCount(card, '.hz-Listing-priority')) > 0;
    const text = ((await card.textContent().catch(() => null)) || '').toLowerCase();
    const isAd =
      hasPriority ||
      text.includes('topadvertentie') ||
      text.includes('topzoekertje') ||
      text.includes('gesponsord') ||
      /\badvertentie\b/.test(text);
    if (isAd) continue;

    // url + titel verplicht
    const href =
      (await safeAttr(card, 'a[href*="/v/auto-s/"]', 'href')) ??
      (await safeAttr(card, 'a[href]', 'href'));
    const pageOrigin = await page.evaluate(() => globalThis.location.origin);
    const url = href ? new URL(href, pageOrigin).href : null;

    const title =
      (await safeText(card, '[data-testid="listing-title"], h3, h2, a[title]')) ||
      (await safeText(card, 'a[title]'));
    if (!url || !title) continue;

    // prijs / datum
    const priceRaw = await safeText(
      card,
      '[data-testid="price-box-price"], .hz-Listing-price, [class*="price"]'
    );
    const priceEUR = parsePriceEUR(priceRaw);
    const date = await safeText(card, '.hz-Listing-listingDate');

    // icon-rij: jaar/km/brandstof/transmissie/carrosserie
    const attrTexts = await safeTexts(card, '.hz-Attribute.hz-Attribute--default');
    const { year, mileageKm, fuel, transmission, body } = classifyAttributes(attrTexts);

    // opties
    const optionsText = await safeText(card, '.hz-Listing-attribute-options');
    const options = optionsText ? optionsText.split(',').map((t) => clean(t)).filter(Boolean) : null;

    // verkoper + stad
    const sellerName = await safeText(card, '.hz-Listing-seller-name');
    const sellerCity = await safeText(card, '.hz-Listing-sellerLocation');

    // adId
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
      listUrlUsed: page.url(), // met cache-buster
    };
  }

  return null;
}

async function waitForFiltersApplied(page) {
  const deadline = Date.now() + 15000;

  // helper: eerste niet-gesponsorde kaart
  const getFirstNormalCard = async () => {
    const cards = await page.$$('li.hz-Listing');
    for (const card of cards) {
      if (await card.$('.hz-Listing-priority')) continue;
      const txt = (await card.textContent())?.toLowerCase() || '';
      if (txt.includes('topzoekertje') || txt.includes('topadvertentie')) continue;
      return card;
    }
    return null;
  };

  while (Date.now() < deadline) {
    const card = await getFirstNormalCard();
    if (card) {
      const txt = (await card.textContent())?.toLowerCase() || '';
      // NL + FR indicatoren dat de lijst net ververst/gesorteerd is
      if (/\b(vandaag|gisteren|min|uur|heures|minute|minutes|aujourd’hui|aujourd'hui)\b/.test(txt)) {
        return; // filters lijken actief
      }
    }
    // probeer sorteermenu forceren
    const sortBtn = await page
      .locator('button:has-text("Sorteer"), [aria-label*="Sorteer"], button:has-text("Trier"), [aria-label*="Trier"]')
      .first();
    if (await sortBtn.count()) {
      await sortBtn.click({ timeout: 1000 }).catch(() => {});
      // klik "Datum: nieuwste eerst" (NL/FR varianten)
      await page.locator('text=/Datum.*nieuwste|Date.*récen|récents/i').first().click({ timeout: 1000 }).catch(() => {});
    }
    await page.waitForTimeout(500);
    await page.mouse.wheel(0, 400);
  }
  // geen harde garantie, maar we hebben het geprobeerd
}

/* ---------- utils ---------- */

function addCacheBuster(u) {
  // voeg ?_ts=... vóór de '#...' in
  const ts = `_ts=${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const i = u.indexOf('#');
  if (i === -1) return u + (u.includes('?') ? '&' : '?') + ts;
  const base = u.slice(0, i);
  const hash = u.slice(i);
  return base + (base.includes('?') ? '&' : '?') + ts + hash;
}

function readLast() {
  try { return JSON.parse(fs.readFileSync(LAST_STATE_PATH, 'utf8')); } catch { return null; }
}
function writeLast(obj) {
  try { fs.writeFileSync(LAST_STATE_PATH, JSON.stringify(obj)); } catch {}
}

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
