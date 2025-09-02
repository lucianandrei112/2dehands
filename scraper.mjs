import { chromium } from 'playwright';

const NAV_TIMEOUT = 10000;
const SHORT_TIMEOUT = 600;
const MAX_CARDS = Number(process.env.MAX_CARDS || 25);
const SCROLL_BUDGET_MS = Number(process.env.SCROLL_BUDGET_MS || 7000);
const SCROLL_STEP_PX = Number(process.env.SCROLL_STEP_PX || 2000);

// NIEUW: Roterende User Agents om detectie te vermijden
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36'
];

const clean = (s) => (s ?? '').replace(/\s+/g, ' ').trim() || null;

let browser;
// NIEUW: Track aantal requests om browser te verversen
let requestCount = 0;
const MAX_REQUESTS_BEFORE_REFRESH = 25; // Ververs browser elke 25 requests

// NIEUW: Track laatste resultaat om rate limiting te detecteren
let lastFoundAdId = null;
let sameResultCount = 0;

/* ------------ Browser lifecycle (reliable) ------------ */

async function launchBrowser() {
  const launchArgs = (process.env.PLAYWRIGHT_CHROMIUM_ARGS || '')
    .split(' ')
    .filter(Boolean);
  
  // NIEUW: Voeg meer stealth argumenten toe
  const defaultArgs = [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-blink-features=AutomationControlled', // NIEUW: Verberg automation
    '--disable-features=IsolateOrigins,site-per-process', // NIEUW
    '--disable-gpu',
    '--disable-web-security',
    '--disable-features=IsolateOrigins',
    '--disable-site-isolation-trials'
  ];
  
  browser = await chromium.launch({
    headless: true,
    args: launchArgs.length ? launchArgs : defaultArgs,
  });
  return browser;
}

/** Launch once & reuse. Relaunch when disconnected/crashed. */
export async function ensureBrowser() {
  // NIEUW: Forceer browser refresh na X requests
  if (requestCount >= MAX_REQUESTS_BEFORE_REFRESH) {
    console.log(`[ANTI-RATE-LIMIT] Refreshing browser after ${requestCount} requests...`);
    await closeBrowser();
    requestCount = 0;
    // NIEUW: Korte pauze na browser refresh
    await new Promise(r => setTimeout(r, 2000));
  }
  
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
  requestCount++; // NIEUW: Tel requests
  
  try {
    const result = await doScrape(listUrl, logger);
    
    // NIEUW: Check voor rate limiting
    if (result && result.adId) {
      if (result.adId === lastFoundAdId) {
        sameResultCount++;
        console.log(`[WARNING] Same ad found ${sameResultCount} times: ${result.adId}`);
        
        // Als we 5x dezelfde auto krijgen, forceer browser refresh
        if (sameResultCount >= 5) {
          console.log('[ANTI-RATE-LIMIT] Detected possible rate limiting, forcing refresh...');
          await closeBrowser();
          requestCount = 0;
          sameResultCount = 0;
          // Wacht 5 seconden
          await new Promise(r => setTimeout(r, 5000));
        }
      } else {
        sameResultCount = 0;
        lastFoundAdId = result.adId;
      }
    }
    
    return result;
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
    // NIEUW: Random user agent selecteren
    const randomUA = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
    
    // NIEUW: Random viewport grootte (kleine variaties)
    const viewportWidth = 1920 + Math.floor(Math.random() * 100);
    const viewportHeight = 1080 + Math.floor(Math.random() * 100);
    
    // NIEUW: Random delay voor menselijk gedrag (0.5-2 seconden)
    await new Promise(r => setTimeout(r, 500 + Math.random() * 1500));
    
    context = await b.newContext({ 
      locale: 'nl-BE', 
      userAgent: randomUA, // NIEUW: Gebruik random UA
      deviceScaleFactor: 1,
      viewport: { width: viewportWidth, height: viewportHeight }, // NIEUW: Random viewport
      // NIEUW: Extra headers voor meer realisme
      extraHTTPHeaders: {
        'Accept-Language': 'nl-BE,nl;q=0.9,en;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Upgrade-Insecure-Requests': '1',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache'
      }
    });
    
    // NIEUW: Voeg Playwright stealth toe
    await context.addInitScript(() => {
      // Verberg webdriver property
      Object.defineProperty(navigator, 'webdriver', {
        get: () => undefined
      });
      // Verberg Chrome automation
      window.chrome = {
        runtime: {}
      };
      // Verberg permission query
      const originalQuery = window.navigator.permissions.query;
      window.navigator.permissions.query = (parameters) => (
        parameters.name === 'notifications' ?
          Promise.resolve({ state: Notification.permission }) :
          originalQuery(parameters)
      );
    });
    
    page = await context.newPage();

    // NIEUW: Voeg timestamp aan URL om caching te voorkomen
    const urlWithTimestamp = listUrl + (listUrl.includes('?') ? '&' : '?') + '_t=' + Date.now();
    
    logger?.debug?.({ listUrl: urlWithTimestamp }, 'goto');
    await page.goto(urlWithTimestamp, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });

    await dismissCookies(page);
    await page.waitForSelector('li.hz-Listing', { timeout: NAV_TIMEOUT });

    // NIEUW: Meer menselijke scroll delays
    await page.evaluate(() => window.scrollBy(0, 700));
    await page.waitForTimeout(150 + Math.random() * 100); // Random delay

    const datedCards = page.locator('li.hz-Listing:has(.hz-Listing-listingDate)');

    // Scroll door tot we minstens MAX_CARDS dated cards zien
    const t0 = Date.now();
    let lastCount = 0;
    while (Date.now() - t0 < SCROLL_BUDGET_MS) {
      const count = await datedCards.count();
      if (count >= MAX_CARDS) break;
      if (count === lastCount) await page.waitForTimeout(150 + Math.random() * 50);
      await page.evaluate((y) => window.scrollBy(0, y), SCROLL_STEP_PX);
      await page.waitForTimeout(220 + Math.random() * 80); // NIEUW: Random delays
      lastCount = count;
    }

    const total = Math.min(await datedCards.count(), MAX_CARDS);
    
    // NIEUW: Log voor debugging
    console.log(`[SCRAPE] Found ${total} dated cards, checking for non-ads...`);

    for (let i = 0; i < total; i++) {
      const card = datedCards.nth(i);
      await card.waitFor({ state: 'attached', timeout: NAV_TIMEOUT });

      // Skip topadvertenties/gesponsord
      const hasPriority = (await safeCount(card, '.hz-Listing-priority')) > 0;
      const text = ((await card.textContent().catch(() => null)) || '').toLowerCase();
      const isAd =
        hasPriority ||
        text.includes('topadvertentie') ||
        text.includes('topzoekertje') ||
        text.includes('gesponsord') ||
        /\badvertentie\b/.test(text);
      
      if (isAd) {
        console.log(`[SCRAPE] Skipping ad at position ${i}`);
        continue;
      }

      // Verplicht: url + titel
      const href =
        (await safeAttr(card, 'a[href*="/v/auto-s/"]', 'href')) ??
        (await safeAttr(card, 'a[href]', 'href'));
      const pageOrigin = await page.evaluate(() => globalThis.location.origin);
      const url = href ? new URL(href, pageOrigin).href : null;

      const title =
        (await safeText(card, '[data-testid="listing-title"], h3, h2, a[title]')) ||
        (await safeText(card, 'a[title]'));

      if (!url || !title) continue;

      // Optioneel data
      const priceRaw = await safeText(
        card,
        '[data-testid="price-box-price"], .hz-Listing-price, [class*="price"]'
      );
      const priceEUR = parsePriceEUR(priceRaw);
      const date = await safeText(card, '.hz-Listing-listingDate');

      const attrTexts = await safeTexts(card, '.hz-Attribute.hz-Attribute--default');
      const { year, mileageKm, fuel, transmission, body } = classifyAttributes(attrTexts);

      const optionsText = await safeText(card, '.hz-Listing-attribute-options');
      const options = optionsText ? optionsText.split(',').map((t) => clean(t)).filter(Boolean) : null;

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

      // NIEUW: Log gevonden auto
      console.log(`[FOUND] First organic listing: ${title.substring(0, 50)} (ID: ${adId})`);

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

    throw new Error(`Geen normale (niet-gesponsorde) kaart gevonden in de eerste ${total || 0}.`);
  } finally {
    try { if (page) await page.close(); } catch {}
    try { if (context) await context.close(); } catch {}
  }
}

/* ---------- helpers (ongewijzigd) ---------- */

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
  const bodies = ['berline','sedan','hatchback','break','station','stationwagen','stationwagon','suv','coupe','coupé','cabri','cabrio','cabriolet','mpv','monovolume','pick-up','pickup','bestelwagen','bestel','coupé'];

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
